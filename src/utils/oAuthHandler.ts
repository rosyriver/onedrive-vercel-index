import axios from 'axios'
import CryptoJS from 'crypto-js'

import apiConfig from '../../config/api.config'

// The Microsoft client secret is stored as an obfuscated value in the environment.
// Only the server should ever decode it.
const AES_SECRET_KEY = 'onedrive-vercel-index'
export function revealObfuscatedToken(obfuscated: string): string {
  const decrypted = CryptoJS.AES.decrypt(obfuscated, AES_SECRET_KEY)
  return decrypted.toString(CryptoJS.enc.Utf8)
}

export function generateAuthorisationUrl(clientId: string): string {
  const { redirectUri, authApi, scope } = apiConfig
  const authUrl = authApi.replace('/token', '/authorize')

  const params = new URLSearchParams()
  params.append('client_id', clientId)
  params.append('redirect_uri', redirectUri)
  params.append('response_type', 'code')
  params.append('scope', scope)
  params.append('response_mode', 'query')

  return `${authUrl}?${params.toString()}`
}

export async function requestTokenWithAuthCode(code: string): Promise<
  | { expiryTime: string; accessToken: string; refreshToken: string }
  | { error: string; errorDescription: string; errorUri: string }
> {
  try {
    const { clientId, redirectUri, authApi } = apiConfig
    const clientSecret = revealObfuscatedToken(apiConfig.obfuscatedClientSecret)

    const params = new URLSearchParams()
    params.append('client_id', clientId)
    params.append('redirect_uri', redirectUri)
    params.append('client_secret', clientSecret)
    params.append('code', code)
    params.append('grant_type', 'authorization_code')

    return axios
      .post(authApi, params, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      })
      .then(resp => {
        const { expires_in, access_token, refresh_token } = resp.data
        return { expiryTime: expires_in, accessToken: access_token, refreshToken: refresh_token }
      })
      .catch(err => {
        const error = err?.response?.data?.error ?? 'token_request_failed'
        const error_description = err?.response?.data?.error_description ?? 'Failed to request tokens.'
        const error_uri = err?.response?.data?.error_uri ?? ''
        return { error, errorDescription: error_description, errorUri: error_uri }
      })
  } catch (error) {
    console.error('Failed to exchange auth code for tokens:', error)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { error: 'Failed to request tokens', errorDescription: errorMessage, errorUri: '' }
  }
}

export async function getAuthPersonInfo(accessToken: string) {
  const profileApi = apiConfig.driveApi.replace('/drive', '')
  return axios.get(profileApi, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
}
