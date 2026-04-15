import axios from 'axios'

export function extractAuthCodeFromRedirected(url: string, redirectUri: string): string {
  if (!url.startsWith(redirectUri)) {
    return ''
  }

  const params = new URLSearchParams(url.split('?')[1] ?? '')
  return params.get('code') ?? ''
}

export async function sendTokenToServer(accessToken: string, refreshToken: string, expiryTime: string | number) {
  return axios.post(
    '/api',
    {
      accessToken,
      accessTokenExpiry: Number(expiryTime),
      refreshToken,
    },
    {
      headers: {
        'Content-Type': 'application/json',
      },
    }
  )
}
