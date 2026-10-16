/**
 * Attaching a custom domain bought through Cloudflare Registrar.
 *
 * Buying at Cloudflare is what makes this tractable: the domain lands in the
 * account already on Cloudflare's nameservers with its zone active, so changing
 * nameservers elsewhere, propagation waits, transfer locks and auth codes never
 * happen. The purchase itself is done in the owner's browser — it needs payment
 * details, which the app must never touch.
 */
import https from 'node:https'
import { Resolver } from 'node:dns/promises'
import type { CloudflareClient } from './cloudflare/api.js'
import { deploySite } from './cloudflare/deploy.js'
import { build, setBaseUrl } from './site/hugo.js'
import type { BlogConfig } from '../shared/types.js'

export interface DomainProgress {
  phase: 'finding-zone' | 'attaching' | 'rebuilding' | 'publishing' | 'securing' | 'done'
  detail?: string
}

export interface DomainResult {
  ok: boolean
  /** The hostname is attached to the Worker, even if it is not answering yet. */
  attached?: boolean
  /** Normalised apex, e.g. "alice.com" — what to save as the custom domain. */
  domain?: string
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
    return {
      ok: false,
      attached: true,
      domain: apex,
      message: 'The blog could not be rebuilt for the new address.',
      log: built.log,
    }
  }

  // Redeploy so absolute URLs (RSS, social cards, canonical links) use the
  // new address now rather than at the next publish.
  onProgress({ phase: 'publishing' })
  try {
    await deploySite(cf, {
      accountId: config.accountId,
      scriptName: config.name,
      bucket: config.bucket,
      publicDir: built.publicDir,
    })
  } catch (e) {
    return {
      ok: false,
      attached: true,
      domain: apex,
      message: `${apex} is set up, but the blog could not be republished. Publish any post to finish.`,
      log: e instanceof Error ? e.message : String(e),
    }
  }

  // ---- 4. Do not reveal the link before the certificate is live. Cloudflare
  // provisions it automatically but it can take a minute or two, and in that
  // window the site answers with an SSL warning — someone non-technical who
  // visits then concludes they have broken their blog and paid for the privilege.
  onProgress({ phase: 'securing' })
  const url = `https://${apex}/`
  const ready = await waitForHttps(apex, { timeoutMs: 300_000, intervalMs: 5_000 })
  if (!ready) {
    return {
      ok: false,
      attached: true,
      domain: apex,
      url,
      message:
        `${apex} is set up but is still being secured. This can take a few minutes — ` +
        `check again shortly.`,
    }
  }

  onProgress({ phase: 'done' })
  return { ok: true, attached: true, domain: apex, url }
}

/**
 * Poll https://<host>/ until it answers 200, resolving through Cloudflare's DNS.
 *
 * Not the system resolver: a lookup made before the record existed (a browser,
 * a router, a previous check) is cached as "no such host" for up to ~30 min,
 * so the domain can be fully live while this machine still cannot see it.
 */
export async function waitForHttps(
  host: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const resolver = new Resolver()
  resolver.setServers(['1.1.1.1', '1.0.0.1'])
  const deadline = Date.now() + (opts.timeoutMs ?? 180_000)

  while (Date.now() < deadline) {
    try {
      const [address] = await resolver.resolve4(host)
      const status = await new Promise<number>((resolve, reject) => {
        const req = https.get(
          {
            host,
            path: '/',
            timeout: 10_000,
            // Connect to the address we resolved; TLS still verifies `host`.
            lookup: (_h, options, cb) =>
              (options as { all?: boolean }).all ? cb(null, [{ address, family: 4 }]) : cb(null, address, 4),
          },
          (res) => {
            res.resume()
            resolve(res.statusCode ?? 0)
          },
        )
        req.on('timeout', () => req.destroy(new Error('timeout')))
        req.on('error', reject)
      })
      if (status === 200) return true
    } catch {
      /* not resolvable or not secured yet */
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 3_000))
  }
  return false
}
