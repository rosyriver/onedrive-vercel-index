import { randomUUID } from 'node:crypto'
import type Redis from 'ioredis'

export const AUTH_HISTORY_DAYS = 180
export const AUTH_HISTORY_LIMIT = 10_000
const retentionSeconds = AUTH_HISTORY_DAYS * 24 * 60 * 60

export type AuthSource = 'request' | 'cron' | 'authorization'
type AuthEventKind =
  | 'refresh_succeeded'
  | 'refresh_failed'
  | 'tokens_saved'
  | 'tokens_cleared'
  | 'refresh_token_missing'
  | 'token_store_failed'
type AuthPhase = 'token_read' | 'token_refresh' | 'token_write' | 'token_clear'

const oauthErrors = new Set([
  'invalid_grant',
  'invalid_client',
  'invalid_request',
  'invalid_scope',
  'unauthorized_client',
  'interaction_required',
  'consent_required',
  'temporarily_unavailable',
  'server_error',
])
const networkErrors = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED'])

// Never persist raw errors, messages, request bodies, headers, tokens or secrets.
// Microsoft numeric codes distinguish causes such as revoked grants and expired secrets.
export function authErrorDetails(error: unknown) {
  const response = (error as any)?.response
  const data = response?.data
  const rawCode = (error as any)?.code
  const errorCodes = Array.isArray(data?.error_codes)
    ? data.error_codes.filter((code: unknown) => Number.isSafeInteger(code) && Number(code) >= 0).slice(0, 10)
    : []
  const httpStatus =
    Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599 ? response.status : undefined
  return {
    providerError: oauthErrors.has(data?.error) ? (data.error as string) : undefined,
    errorCodes: errorCodes as number[],
    httpStatus: httpStatus as number | undefined,
    networkError: networkErrors.has(rawCode) ? (rawCode as string) : undefined,
  }
}

export interface AuthEvent {
  kind: AuthEventKind
  source: AuthSource
  phase?: AuthPhase
  error?: unknown
}

// One atomic round trip per actual auth event. Successes cannot evict failures.
// Snapshots have no TTL: recovery and history trimming never erase the last failure/clear reason.
export const RECORD_AUTH_EVENT = `
local event = ARGV[1]
local now = tonumber(ARGV[2])
redis.call('HSET', KEYS[1], 'last_event', event, ARGV[3], event)
redis.call('ZADD', KEYS[2], now, event)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - tonumber(ARGV[4]) * 1000.0)
local excess = redis.call('ZCARD', KEYS[2]) - tonumber(ARGV[5])
if excess > 0 then
  redis.call('ZREMRANGEBYRANK', KEYS[2], 0, excess - 1)
end
redis.call('EXPIRE', KEYS[2], ARGV[4])
return 1
`

export function createAuthDiagnostics(
  redis: Pick<Redis, 'eval'>,
  prefix: string,
  now: () => number = Date.now,
  warn: () => void = () => console.warn('Could not persist auth diagnostics.'),
) {
  return async function recordAuthEvent(event: AuthEvent): Promise<void> {
    try {
      const timestamp = now()
      const success = event.kind === 'refresh_succeeded' || event.kind === 'tokens_saved'
      const field = success
        ? 'last_success'
        : event.kind === 'tokens_cleared'
          ? 'last_token_clear'
          : event.kind === 'refresh_token_missing'
            ? 'last_missing_refresh_token'
            : 'last_failure'
      // Copy only allowed fields, even if a caller accidentally supplies an Axios error object.
      const payload = JSON.stringify({
        id: randomUUID(),
        time: new Date(timestamp).toISOString(),
        kind: event.kind,
        source: event.source,
        phase: event.phase,
        ...(event.error === undefined ? {} : authErrorDetails(event.error)),
      })
      await redis.eval(
        RECORD_AUTH_EVENT,
        2,
        `${prefix}auth:diagnostics:state`,
        `${prefix}auth:diagnostics:${success ? 'successes' : 'failures'}`,
        payload,
        String(timestamp),
        field,
        retentionSeconds,
        AUTH_HISTORY_LIMIT,
      )
    } catch {
      // Diagnostic failures must not turn a successful refresh into an outage.
      warn()
    }
  }
}
