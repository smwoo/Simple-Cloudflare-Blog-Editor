/**
 * Deploying the built site to a Worker with static assets and an R2 binding.
 *
 * There is no git and no CI: the app builds locally and uploads directly, so a
 * build failure surfaces in the app before anything is published, rather than
 * remotely afterwards where the owner cannot see it.
 *
 * The upload is a three-step dance, the same one wrangler performs:
 *   1. POST a manifest of {path: {hash, size}} and get back a JWT plus the
 *      buckets of hashes Cloudflare does not already have.
 *   2. Upload only those files, base64, against the JWT.
 *   3. PUT the script with the resulting completion token in its metadata.
 * Step 1 is what makes republishing cheap: unchanged assets are never re-sent.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { CloudflareClient } from './api.js'
import { contentTypeFor } from './r2.js'

const COMPATIBILITY_DATE = '2026-07-26'

/** The Worker: static assets, plus /media/* read from the R2 binding. */
export const WORKER_SOURCE = `export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    if (!url.pathname.startsWith('/media/')) return env.ASSETS.fetch(req)

    const key = decodeURIComponent(url.pathname.slice('/media/'.length))
    const obj = await env.MEDIA.get(key)
    if (!obj) return new Response('Not found', { status: 404 })

    const headers = new Headers()
    obj.writeHttpMetadata(headers)
    headers.set('etag', obj.httpEtag)
    // Media keys are never reused, so this can be immutable. Cloudflare's CDN
    // caches on it, which is why repeat views never reach the Worker.
    headers.set('cache-control', 'public, max-age=31536000, immutable')
    // Pages carry a robots meta tag; photos and videos can only say it here.
    headers.set('x-robots-tag', 'noindex')
    return new Response(obj.body, { headers })
  },
}
`

const SITE_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
}

function siteContentType(sitePath: string): string {
  return SITE_TYPES[path.extname(sitePath).toLowerCase()] ?? contentTypeFor(sitePath)
}

interface ManifestEntry {
  hash: string
  size: number
}

/** Cloudflare keys assets by a 32-char hash of contents. */
function assetHash(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 32)
}

async function walk(dir: string, base = dir): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full, base)))
    else if (entry.isFile()) out.push(path.relative(base, full))
  }
  return out
}

export interface DeployResult {
  uploaded: number
  skipped: number
  totalBytes: number
}

export async function deploySite(
  cf: CloudflareClient,
  opts: {
    accountId: string
    scriptName: string
    bucket: string
    publicDir: string
    onProgress?: (done: number, total: number) => void
  },
): Promise<DeployResult> {
  const files = await walk(opts.publicDir)
  if (!files.length) throw new Error('nothing to deploy: the build produced no files')

  // ---- 1. manifest
  const contents = new Map<string, Buffer>()
  const manifest: Record<string, ManifestEntry> = {}
  let totalBytes = 0

  for (const rel of files) {
    const buf = await readFile(path.join(opts.publicDir, rel))
    const hash = assetHash(buf)
    // Keys are site paths with a leading slash.
    manifest['/' + rel.split(path.sep).join('/')] = { hash, size: buf.length }
    contents.set(hash, buf)
    totalBytes += buf.length
  }

  const session = await cf.request<{
    jwt?: string
    buckets?: string[][]
  }>(`/accounts/${opts.accountId}/workers/scripts/${opts.scriptName}/assets-upload-session`, {
    method: 'POST',
    body: JSON.stringify({ manifest }),
  })

  let completionToken = session?.jwt
  let uploaded = 0
  const buckets = session?.buckets ?? []

  // ---- 2. upload only the hashes Cloudflare is missing
  if (session?.jwt && buckets.some((b) => b.length)) {
    const total = buckets.reduce((n, b) => n + b.length, 0)
    for (const bucket of buckets) {
      if (!bucket.length) continue
      const form = new FormData()
      for (const hash of bucket) {
        const buf = contents.get(hash)
        if (!buf) continue
        const sitePath = Object.keys(manifest).find((k) => manifest[k].hash === hash)!
        // The endpoint only accepts base64 file bodies (and ?base64=true).
        form.append(
          hash,
          new File([buf.toString('base64')], hash, { type: siteContentType(sitePath) }),
        )
      }

      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/workers/assets/upload?base64=true`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.jwt}` },
          body: form,
        },
      )
      const json = (await res.json()) as any
      if (!res.ok || !json?.success) {
        throw new Error(
          `asset upload failed: ${json?.errors?.[0]?.message ?? res.statusText}`,
        )
      }
      uploaded += bucket.length
      opts.onProgress?.(uploaded, total)
      if (json.result?.jwt) completionToken = json.result.jwt
    }
  }

  // ---- 3. deploy the script
  const metadata = {
    main_module: 'index.js',
    compatibility_date: COMPATIBILITY_DATE,
    compatibility_flags: ['nodejs_compat'],
    assets: completionToken
      ? { jwt: completionToken, config: { html_handling: 'auto-trailing-slash' } }
      : { config: { html_handling: 'auto-trailing-slash' } },
    bindings: [
      { type: 'assets', name: 'ASSETS' },
      { type: 'r2_bucket', name: 'MEDIA', bucket_name: opts.bucket },
    ],
    observability: { enabled: true },
  }

  const form = new FormData()
  form.append('metadata', JSON.stringify(metadata))
  form.append(
    'index.js',
    new File([WORKER_SOURCE], 'index.js', { type: 'application/javascript+module' }),
  )

  await cf.request(`/accounts/${opts.accountId}/workers/scripts/${opts.scriptName}`, {
    method: 'PUT',
    body: form,
    raw: form,
  })

  // workers.dev serving must be enabled explicitly; without it the deploy
  // succeeds and the URL still 404s, which is a confusing place to stop.
  await cf
    .request(
      `/accounts/${opts.accountId}/workers/scripts/${opts.scriptName}/subdomain`,
      { method: 'POST', body: JSON.stringify({ enabled: true }) },
    )
    .catch(() => {
      /* already enabled */
    })

  return { uploaded, skipped: files.length - uploaded, totalBytes }
}

/**
 * Poll a URL until it answers 200.
 *
 * Used after both deploy and custom-domain attachment. For a custom domain this
 * is not optional: Cloudflare provisions the certificate automatically but it
 * takes a minute or two, and in that window the site answers with an SSL
 * warning. Someone non-technical who visits then concludes they have broken
 * their blog and paid for the privilege.
 */
export async function waitForLive(
  url: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const timeout = opts.timeoutMs ?? 180_000
  const interval = opts.intervalMs ?? 3_000
  const deadline = Date.now() + timeout

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'follow' })
      if (res.ok) return true
    } catch {
      /* DNS or TLS not ready yet */
    }
    await new Promise((r) => setTimeout(r, interval))
  }
  return false
}
