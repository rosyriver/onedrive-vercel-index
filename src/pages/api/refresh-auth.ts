import type { NextApiRequest, NextApiResponse } from 'next'

import { getAccessToken } from '.'

function setNoStoreHeaders(res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, s-maxage=0')
  res.setHeader('CDN-Cache-Control', 'no-store')
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  setNoStoreHeaders(res)

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed.' })
    return
  }

  if (!process.env.CRON_SECRET) {
    res.status(500).json({ error: 'CRON_SECRET is not configured.' })
    return
  }

  const authHeader = req.headers.authorization
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'Unauthorized.' })
    return
  }

  const accessToken = await getAccessToken(true)
  if (!accessToken) {
    res.status(409).json({ error: 'Re-authentication required.' })
    return
  }

  res.status(200).json({ ok: true, refreshedAt: new Date().toISOString() })
}
