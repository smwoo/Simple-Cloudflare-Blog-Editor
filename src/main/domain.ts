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
  /** Normalised hostname, e.g. "alice.com" or "blog.alice.com" — saved as the custom domain. */
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

/** "https://Blog.Alice.com/x" → "blog.alice.com"; null if it is not a hostname. */
export function normalizeHostname(input: string): string | null {
  const host = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/\.$/, '')
  return /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(host) ? host : null
}

/**
 * Which zone a hostname lives in, and what to attach.
 *
 * A whole domain gets its www twin; a subdomain (blog.alice.com) is attached
 * alone. The longest matching zone wins, so a delegated sub-zone is respected.
 */
export function planHostnames(
  host: string,
  zones: { id: string; name: string }[],
): { zone: { id: string; name: string }; hostnames: string[] } | null {
  const zone = zones
    .filter((z) => host === z.name || host.endsWith(`.${z.name}`))
    .sort((a, b) => b.name.length - a.name.length)[0]
  if (!zone) return null
  return { zone, hostnames: host === zone.name ? [host, `www.${host}`] : [host] }
}

export async function attachDomain(
  domain: string,
  deps: {
    cf: CloudflareClient
    config: BlogConfig
    siteDir: string
    waitForLive?: (host: string) => Promise<boolean>
  },
  onProgress: (p: DomainProgress) => void,
): Promise<DomainResult> {
  const { cf, config, siteDir } = deps
  const waitForLive =
    deps.waitForLive ?? ((h: string) => waitForHttps(h, { timeoutMs: 300_000, intervalMs: 5_000 }))
  const host = normalizeHostname(domain)
  if (!host) {
    return { ok: false, message: `"${domain}" is not a web address. Try something like alice.com or blog.alice.com.` }
  }

  // ---- 1. the zone should already exist, since it was bought at Cloudflare
  onProgress({ phase: 'finding-zone' })
  let plan = planHostnames(host, await cf.listZones().catch(() => []))
  for (let i = 0; i < 10 && !plan; i++) {
    // Registration takes a moment to appear in the API.
    await new Promise((r) => setTimeout(r, 3000))
    plan = planHostnames(host, await cf.listZones().catch(() => []))
  }
  if (!plan) {
    return {
      ok: false,
      message:
        `We cannot find ${host} in your Cloudflare account. If you have just bought ` +
        `the domain, wait a minute and try again. If it is registered somewhere else, ` +
        `that is not supported yet.`,
    }
  }

  // Never take a hostname from another Worker: attaching silently moves it, and
  // whatever that Worker served (another blog, say) would vanish.
  const existing = await cf.listCustomDomains(config.accountId).catch(() => [])
  const taken = existing.find((d) => d.hostname === host && d.service !== config.name)
  if (taken) {
    return {
      ok: false,
      message:
        `${host} is already used by another site in your Cloudflare account ` +
        `("${taken.service}"). Pick a different address, or remove it from that site first.`,
    }
  }

  // ---- 2. attach as Worker Custom Domains. Cloudflare creates the DNS record
  // and orders the certificate — far simpler than DNS records and routes by hand.
  onProgress({ phase: 'attaching', detail: host })
  for (const hostname of plan.hostnames) {
    if (existing.some((d) => d.hostname === hostname && d.service !== config.name)) continue
    try {
      await cf.attachCustomDomain(config.accountId, {
        hostname,
        zoneId: plan.zone.id,
        service: config.name,
      })
    } catch (e) {
      const err = e as { status?: number; message?: string }
      if (err.status === 403 || err.status === 401) {
        return {
          ok: false,
          message:
            'The app does not have permission to set up a web address. Its Cloudflare ' +
            'token needs the "Zone — Read" permission.',
          log: err.message,
        }
      }
      // www is a nicety; the address itself is not.
      if (hostname === host) {
        return {
          ok: false,
          message: /dns record/i.test(err.message ?? '')
            ? `${host} already has a DNS record pointing somewhere else. Delete that ` +
              `record in the Cloudflare dashboard (DNS → Records), then try again.`
            : `Could not attach ${host}.`,
          log: err.message,
        }
      }
    }
  }

  onProgress({ phase: 'rebuilding' })
  await setBaseUrl(siteDir, `https://${host}`)
  const built = await build(siteDir)
  if (!built.ok) {
    return {
      ok: false,
      attached: true,
      domain: host,
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
      domain: host,
      message: `${host} is set up, but the blog could not be republished. Publish any post to finish.`,
      log: e instanceof Error ? e.message : String(e),
    }
  }

  // ---- 4. Do not reveal the link before the certificate is live. Cloudflare
  // provisions it automatically but it can take a minute or two, and in that
  // window the site answers with an SSL warning — someone non-technical who
  // visits then concludes they have broken their blog and paid for the privilege.
  onProgress({ phase: 'securing' })
  const url = `https://${host}/`
  const ready = await waitForLive(host)
  if (!ready) {
    return {
      ok: false,
      attached: true,
      domain: host,
      url,
      message:
        `${host} is set up but is still being secured. This can take a few minutes — ` +
        `check again shortly.`,
    }
  }

  onProgress({ phase: 'done' })
  return { ok: true, attached: true, domain: host, url }
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

/** Addresses attached to this blog's Worker; a www twin is folded into its domain. */
export async function listBlogDomains(
  cf: CloudflareClient,
  config: BlogConfig,
): Promise<{ hostname: string; withWww: boolean; primary: boolean }[]> {
  const mine = (await cf.listCustomDomains(config.accountId)).filter((d) => d.service === config.name)
  const names = new Set(mine.map((d) => d.hostname))
  return [...names]
    .filter((h) => !(h.startsWith('www.') && names.has(h.slice(4))))
    .sort()
    .map((hostname) => ({
      hostname,
      withWww: names.has(`www.${hostname}`),
      primary: hostname === config.customDomain,
    }))
}

export interface RemoveResult {
  ok: boolean
  /** The blog's address after removal: another attached one, or undefined for workers.dev. */
  customDomain?: string
  message?: string
  log?: string
}

/**
 * Detach an address (and its www twin) from this blog's Worker. Cloudflare
 * deletes the DNS record it created. If it was the main address, the blog
 * falls back to another attached one or workers.dev, and is republished so
 * its links stop pointing at the removed address.
 */
export async function removeDomain(
  hostname: string,
  deps: { cf: CloudflareClient; config: BlogConfig; siteDir: string },
): Promise<RemoveResult> {
  const { cf, config, siteDir } = deps
  const host = normalizeHostname(hostname)
  const mine = (await cf.listCustomDomains(config.accountId)).filter((d) => d.service === config.name)
  const targets = mine.filter((d) => d.hostname === host || d.hostname === `www.${host}`)
  if (!host || !targets.length) {
    return { ok: false, customDomain: config.customDomain, message: `${hostname} is not attached to this blog.` }
  }

  for (const d of targets) {
    try {
      await cf.detachCustomDomain(config.accountId, d.id)
    } catch (e) {
      const err = e as { status?: number; message?: string }
      return {
        ok: false,
        customDomain: config.customDomain,
        message:
          err.status === 401 || err.status === 403
            ? 'The app does not have permission to remove web addresses.'
            : `Could not remove ${d.hostname}.`,
        log: err.message,
      }
    }
  }

  if (config.customDomain !== host) return { ok: true, customDomain: config.customDomain }

  const remaining = mine
    .filter((d) => !targets.includes(d))
    .map((d) => d.hostname)
    .filter((h) => !h.startsWith('www.'))
    .sort()
  const next = remaining[0]
  await setBaseUrl(siteDir, next ? `https://${next}` : config.siteUrl)
  const built = await build(siteDir)
  if (!built.ok) {
    return { ok: false, customDomain: next, message: 'Removed, but the blog could not be rebuilt.', log: built.log }
  }
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
      customDomain: next,
      message: 'Removed, but the blog could not be republished. Publish any post to finish.',
      log: e instanceof Error ? e.message : String(e),
    }
  }
  return { ok: true, customDomain: next }
}
