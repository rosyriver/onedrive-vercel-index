const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const ts = require('typescript')
const Redis = require('ioredis-mock')

// Compile just the module under test. Dependencies are explicit, so tests never
// open a network connection or read deployment credentials.
function loadModule(relativePath, mocks = {}) {
  const filename = path.resolve(__dirname, '..', relativePath)
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const localRequire = createRequire(filename)
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output)(
    name => (Object.hasOwn(mocks, name) ? mocks[name] : localRequire(name)),
    module,
    module.exports,
  )
  return module.exports
}

const { createAuthDiagnostics, AUTH_HISTORY_DAYS, AUTH_HISTORY_LIMIT } = loadModule('src/utils/authDiagnostics.ts')
const day = 24 * 60 * 60 * 1000
const start = Date.parse('2026-10-29T00:00:00Z')
const prefix = 'test:'
const stateKey = `${prefix}auth:diagnostics:state`
const failuresKey = `${prefix}auth:diagnostics:failures`
const successesKey = `${prefix}auth:diagnostics:successes`
const clients = []

afterEach(() => {
  for (const client of clients.splice(0)) client.disconnect()
})

async function fixture() {
  const redis = new Redis()
  clients.push(redis)
  await redis.flushall()
  let time = start
  let warnings = 0
  const record = createAuthDiagnostics(
    redis,
    prefix,
    () => time,
    () => {
      warnings++
    },
  )
  return {
    redis,
    record,
    setTime: value => {
      time = value
    },
    warnings: () => warnings,
  }
}

function microsoftError(code = 'invalid_grant') {
  return {
    message: 'SECRET_SENTINEL',
    config: { headers: { Authorization: 'SECRET_SENTINEL' }, data: 'refresh_token=SECRET_SENTINEL' },
    response: {
      status: 400,
      data: {
        error: code,
        error_codes: [700082, 'SECRET_SENTINEL', -1, {}, 0.5],
        error_description: 'SECRET_SENTINEL',
        access_token: 'SECRET_SENTINEL',
        refresh_token: 'SECRET_SENTINEL',
      },
    },
  }
}

test('executes Lua, persists safe error codes and never writes raw credentials', async () => {
  const f = await fixture()
  await f.record({ kind: 'refresh_failed', source: 'cron', phase: 'token_refresh', error: microsoftError() })
  assert.equal(f.warnings(), 0)
  const snapshot = await f.redis.hget(stateKey, 'last_failure')
  assert.equal(snapshot.includes('SECRET_SENTINEL'), false)
  assert.equal(JSON.parse(snapshot).providerError, 'invalid_grant')
  assert.deepEqual(JSON.parse(snapshot).errorCodes, [700082])
  assert.equal(await f.redis.zcard(failuresKey), 1)
  assert.equal(await f.redis.ttl(stateKey), -1)
  assert.ok((await f.redis.ttl(failuresKey)) > 179 * 24 * 60 * 60)
  assert.equal(await f.redis.exists('auth:diagnostics:state'), 0)
})

test('successful recovery never replaces the last failure or deletion reason', async () => {
  const f = await fixture()
  await f.record({ kind: 'refresh_failed', source: 'cron', error: microsoftError() })
  await f.record({ kind: 'tokens_cleared', source: 'cron', error: microsoftError() })
  const failure = await f.redis.hget(stateKey, 'last_failure')
  const cleared = await f.redis.hget(stateKey, 'last_token_clear')
  f.setTime(start + 181 * day)
  await f.record({ kind: 'tokens_saved', source: 'authorization' })
  await f.record({ kind: 'refresh_succeeded', source: 'request' })
  assert.equal(await f.redis.hget(stateKey, 'last_failure'), failure)
  assert.equal(await f.redis.hget(stateKey, 'last_token_clear'), cleared)
  assert.equal(JSON.parse(await f.redis.hget(stateKey, 'last_success')).kind, 'refresh_succeeded')
})

test('missing-token observations do not erase the original error', async () => {
  const f = await fixture()
  await f.record({ kind: 'refresh_failed', source: 'cron', error: microsoftError() })
  const failure = await f.redis.hget(stateKey, 'last_failure')
  await f.record({ kind: 'refresh_token_missing', source: 'cron' })
  assert.equal(await f.redis.hget(stateKey, 'last_failure'), failure)
  assert.equal(JSON.parse(await f.redis.hget(stateKey, 'last_missing_refresh_token')).kind, 'refresh_token_missing')
})

test('trims events outside 180 days but preserves permanent snapshots', async () => {
  const f = await fixture()
  await f.record({ kind: 'tokens_cleared', source: 'cron', error: microsoftError() })
  const oldEvent = await f.redis.hget(stateKey, 'last_token_clear')
  f.setTime(start + AUTH_HISTORY_DAYS * day + 1)
  await f.record({ kind: 'refresh_failed', source: 'cron' })
  assert.equal(await f.redis.zcard(failuresKey), 1)
  assert.equal(await f.redis.zscore(failuresKey, oldEvent), null)
  assert.equal(await f.redis.hget(stateKey, 'last_token_clear'), oldEvent)
})

test('caps each history at 10000; successful traffic cannot evict a failure', async () => {
  const f = await fixture()
  await f.record({ kind: 'refresh_failed', source: 'cron', error: microsoftError() })
  const members = []
  for (let i = 0; i < AUTH_HISTORY_LIMIT + 1; i++) members.push(start + i, `seed-${i}`)
  await f.redis.zadd(successesKey, ...members)
  f.setTime(start + AUTH_HISTORY_LIMIT + 2)
  await f.record({ kind: 'refresh_succeeded', source: 'request' })
  assert.equal(await f.redis.zcard(successesKey), AUTH_HISTORY_LIMIT)
  assert.equal(await f.redis.zscore(successesKey, 'seed-0'), null)
  assert.equal(await f.redis.zcard(failuresKey), 1)
})

test('diagnostic Redis failures are best effort and never expose the raw error', async () => {
  let warnings = 0
  const record = createAuthDiagnostics(
    {
      eval: async () => {
        throw microsoftError()
      },
    },
    '',
    () => start,
    () => {
      warnings++
    },
  )
  await assert.doesNotReject(record({ kind: 'refresh_succeeded', source: 'cron' }))
  assert.equal(warnings, 1)
})

function authModule({ tokens, post, store = async () => {}, clear = async () => {}, record }) {
  return loadModule('src/pages/api/index.ts', {
    axios: { post },
    '../../../config/api.config': {
      clientId: 'test',
      redirectUri: 'http://localhost',
      authApi: 'https://example.test/token',
    },
    '../../../config/site.config': { baseDirectory: '/', userPrincipalName: 'owner@example.test' },
    '../../utils/oAuthHandler': {
      revealObfuscatedToken: () => 'SECRET_SENTINEL',
      getAuthPersonInfo: async () => ({ data: { userPrincipalName: 'owner@example.test' } }),
    },
    '../../utils/protectedRouteHandler': {},
    '../../utils/odAuthTokenStore': {
      getOdAuthTokens: async () => tokens,
      storeOdAuthTokens: store,
      clearOdAuthTokens: clear,
    },
    '../../utils/authDiagnostics': loadModule('src/utils/authDiagnostics.ts'),
    '../../utils/odAuthDiagnostics': { recordAuthEvent: record },
    './raw': {},
  })
}

test('ordinary cached-token and missing-token requests add no diagnostic commands', async () => {
  let calls = 0
  const record = async () => {
    calls++
  }
  const cached = authModule({ tokens: { accessToken: 'cached', refreshToken: 'refresh' }, record })
  assert.equal(await cached.getAccessToken(), 'cached')
  const missing = authModule({ tokens: { accessToken: null, refreshToken: null }, record })
  for (let i = 0; i < 20; i++) assert.equal(await missing.getAccessToken(), '')
  assert.equal(calls, 0)
  await missing.getAccessToken(true, 'cron')
  assert.equal(calls, 1)
})

test('invalid_grant persists failure before clearing tokens, then records the actual deletion', async () => {
  const f = await fixture()
  let cleared = false
  const auth = authModule({
    tokens: { accessToken: null, refreshToken: 'SECRET_SENTINEL' },
    post: async () => {
      throw microsoftError()
    },
    record: f.record,
    clear: async () => {
      assert.ok(await f.redis.hget(stateKey, 'last_failure'))
      assert.equal(await f.redis.hget(stateKey, 'last_token_clear'), null)
      cleared = true
    },
  })
  assert.equal(await auth.getAccessToken(true, 'cron'), '')
  assert.equal(cleared, true)
  assert.equal(JSON.parse(await f.redis.hget(stateKey, 'last_token_clear')).providerError, 'invalid_grant')
  assert.equal(await f.redis.zcard(failuresKey), 2)
})

test('invalid_client preserves tokens and records the provider code', async () => {
  const f = await fixture()
  const auth = authModule({
    tokens: { accessToken: null, refreshToken: 'refresh' },
    record: f.record,
    post: async () => {
      throw microsoftError('invalid_client')
    },
    clear: async () => {
      assert.fail('invalid_client must not delete tokens')
    },
  })
  assert.equal(await auth.getAccessToken(), '')
  assert.equal(JSON.parse(await f.redis.hget(stateKey, 'last_failure')).providerError, 'invalid_client')
  assert.equal(await f.redis.hget(stateKey, 'last_token_clear'), null)
})

test('a token storage failure is distinguished from a provider failure', async () => {
  const f = await fixture()
  const auth = authModule({
    tokens: { accessToken: null, refreshToken: 'refresh' },
    record: f.record,
    post: async () => ({ data: { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 } }),
    store: async () => {
      throw new Error('SECRET_SENTINEL')
    },
    clear: async () => {
      assert.fail('a Redis write failure must not delete tokens')
    },
  })
  assert.equal(await auth.getAccessToken(), '')
  const failure = JSON.parse(await f.redis.hget(stateKey, 'last_failure'))
  assert.equal(failure.kind, 'token_store_failed')
  assert.equal(failure.phase, 'token_write')
  assert.equal(await f.redis.hget(stateKey, 'last_success'), null)
})

test('successful forced refresh records success only after saving the new tokens', async () => {
  const f = await fixture()
  let saved = false
  const auth = authModule({
    tokens: { accessToken: 'old-access', refreshToken: 'refresh' },
    post: async () => ({ data: { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 } }),
    store: async () => {
      saved = true
    },
    record: async event => {
      assert.equal(saved, true)
      await f.record(event)
    },
  })
  assert.equal(await auth.getAccessToken(true, 'cron'), 'new-access')
  const success = JSON.parse(await f.redis.hget(stateKey, 'last_success'))
  assert.equal(success.source, 'cron')
  assert.equal(success.kind, 'refresh_succeeded')
})

test('a failed deletion never claims tokens were cleared', async () => {
  const f = await fixture()
  const clearError = new Error('SECRET_SENTINEL')
  const auth = authModule({
    tokens: { accessToken: null, refreshToken: 'refresh' },
    record: f.record,
    post: async () => {
      throw microsoftError()
    },
    clear: async () => {
      throw clearError
    },
  })
  await assert.rejects(auth.getAccessToken(true, 'cron'), clearError)
  assert.equal(await f.redis.hget(stateKey, 'last_token_clear'), null)
  const failure = JSON.parse(await f.redis.hget(stateKey, 'last_failure'))
  assert.equal(failure.kind, 'token_store_failed')
  assert.equal(failure.phase, 'token_clear')
})

test('re-authorization saves an owner-validated success without overwriting the old failure', async () => {
  const f = await fixture()
  await f.record({ kind: 'refresh_failed', source: 'cron', error: microsoftError() })
  const oldFailure = await f.redis.hget(stateKey, 'last_failure')
  let saved = false
  let status
  const auth = authModule({
    record: async event => {
      assert.equal(saved, true)
      await f.record(event)
    },
    store: async () => {
      saved = true
    },
  })
  const res = {
    status(code) {
      status = code
      return this
    },
    send() {},
    json() {},
  }
  await auth.default(
    {
      method: 'POST',
      body: {
        accessToken: 'SECRET_SENTINEL',
        refreshToken: 'SECRET_SENTINEL',
        accessTokenExpiry: 3600,
      },
    },
    res,
  )
  assert.equal(status, 200)
  assert.equal(JSON.parse(await f.redis.hget(stateKey, 'last_success')).kind, 'tokens_saved')
  assert.equal(await f.redis.hget(stateKey, 'last_failure'), oldFailure)
  assert.equal((await f.redis.hgetall(stateKey)).last_success.includes('SECRET_SENTINEL'), false)
})
