/**
 * Attaching a custom domain bought through Cloudflare Registrar.
 *
 * Buying at Cloudflare is what makes this tractable: the domain lands in the
 * account already on Cloudflare's nameservers with its zone active, so changing
 * nameservers elsewhere, propagation waits, transfer locks and auth codes never
 * happen. The purchase itself is done in the owner's browser — it needs payment
 * details, which the app must never touch.
 */
import type { CloudflareClient } from './cloudflare/api.js'
import { waitForLive } from './cloudflare/deploy.js'
import { build } from './site/hugo.js'
import { setBaseUrl } from './site/hugo.js'
import type { BlogConfig } from '../shared/types.js'

export interface DomainProgress {
  phase: 'finding-zone' | 'attaching' | 'rebuilding' | 'securing' | 'done'
  detail?: string
}

export interface DomainResult {
  ok: boolean
  url?: string
  message?: string
  log?: string
}

/** Where the owner completes the purchase. */
export function registrarUrl(accountId: string, domain?: string): string {
  const base = `https://dash.cloudflare.com/${accountId}/domains/register`
  return domain ? `${base}?domain=${encodeURIComponent(domain)}` : base
}

export async function attachDomain(
  domain: string,
  deps: { cf: CloudflareClient; config: BlogConfig; siteDir: string },
  onProgress: (p: DomainProgress) => void,
): Promise<DomainResult> {
  const { cf, config, siteDir } = deps
  const apex = domain.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')

  // ---- 1. the zone should already exist, since it was bought at Cloudflare
  onProgress({ phase: 'finding-zone' })
  let zone = await cf.findZone(apex).catch(() => null)
  for (let i = 0; i < 10 && !zone; i++) {
    // Registration takes a moment to appear in the API.
    await new Promise((r) => setTimeout(r, 3000))
    zone = await cf.findZone(apex).catch(() => null)
  }
  if (!zone) {
    return {
      ok: false,
      message:
        `We cannot find ${apex} in your Cloudflare account. If you have just bought ` +
        `it, wait a minute and try again. If you registered it somewhere else, that ` +
        `is not supported yet.`,
    }
  }

  // ---- 2. attach apex and www as Worker Custom Domains. Cloudflare creates
  // the DNS record and orders the certificate — far simpler than building DNS
  // records and routes by hand.
  onProgress({ phase: 'attaching', detail: apex })
  const attached: { id: string; hostname: string }[] = []
  for (const hostname of [apex, `www.${apex}`]) {
    try {
      const r = await cf.attachCustomDomain(config.accountId, {
        hostname,
        zoneId: zone.id,
        service: config.name,
      })
      if (r?.id) attached.push({ id: r.id, hostname })
    } catch (e) {
      const err = e as { status?: number; message?: string }
      if (err.status === 403 || err.status === 401) {
        return {
          ok: false,
          message:
            'The app does not have permission to set up a web address. It needs ' +
            '"Zone — Read" and "Workers Routes — Edit" adding to its Cloudflare token.',
          log: err.message,
        }
      }
      // www is a nicety; the apex is not.
      if (hostname === apex) {
        return { ok: false, message: `Could not attach ${apex}.`, log: err.message }
      }
    }
  }

  // ---- 3. baseURL and a rebuild is the entire content cost, because media is
  // referenced as /media/... rather than an absolute URL.
  onProgress({ phase: 'rebuilding' })
  await setBaseUrl(siteDir, `https://${apex}`)
  const built = await build(siteDir)
  if (!built.ok) {
    return { ok: false, message: 'The blog could not be rebuilt for the new address.', log: built.log }
  }

  // ---- 4. Do not reveal the link before the certificate is live. Cloudflare
  // provisions it automatically but it takes a minute or two, and in that
  // window the site answers with an SSL warning — someone non-technical who
  // visits then concludes they have broken their blog and paid for the privilege.
  onProgress({ phase: 'securing' })
  const url = `https://${apex}/`
  const ready = await waitForLive(url, { timeoutMs: 300_000, intervalMs: 5_000 })
  if (!ready) {
    return {
      ok: false,
      url,
      message:
        `${apex} is set up but is still being secured. This can take a few minutes — ` +
        `check again shortly.`,
    }
  }

  onProgress({ phase: 'done' })
  return { ok: true, url }
}
