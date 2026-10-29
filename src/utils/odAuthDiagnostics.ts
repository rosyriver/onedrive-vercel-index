import siteConfig from '../../config/site.config'
import { createAuthDiagnostics } from './authDiagnostics'
import { kv } from './odAuthTokenStore'

export const recordAuthEvent = createAuthDiagnostics(kv, siteConfig.kvPrefix)
