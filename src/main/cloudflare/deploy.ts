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
import { ensureCommentsDatabase } from './comments.js'

const COMPATIBILITY_DATE = '2026-07-26'

/**
 * The Worker: static assets, /media/* read from the R2 binding, and
 * /api/comments, /api/subscribe and /api/unsubscribe backed by the visitors'
 * database (see comments.ts and newsletter.ts).
 *
 * Comment rules enforced here, since the page's script is only a courtesy:
 * the post must be a published page, a reply always joins the top comment's
 * thread, lengths are capped, and one address can post a few per ten minutes.
 * POST demands a JSON body, which a form on another site cannot send without
 * a CORS preflight this Worker never answers.
 *
 * Subscribing follows the same rules, works only while the owner has the box
 * turned on, and answers the same whether or not the address was already on
 * the list, so the box cannot tell anyone who subscribed. Unsubscribing takes
 * the token from the email's link: opening the link only asks, since mail
 * scanners open links, and the button (or a mail app's one-click unsubscribe,
 * RFC 8058) is the POST that removes the address.
 */
export const WORKER_SOURCE = `const MAX_NAME = 60
const MAX_BODY = 2000
const RATE_WINDOW_MS = 10 * 60 * 1000
const RATE_MAX = 5
const SLUG = /^[a-z0-9][a-z0-9-]{0,119}$/
const MAX_EMAIL = 254
const EMAIL = /^[^\\s@<>"]+@[^\\s@<>"]+\\.[^\\s@<>"]+$/
const TOKEN = /^[0-9a-f]{32}$/

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

async function ipHash(req) {
  const ip = req.headers.get('cf-connecting-ip') || ''
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('comments:' + ip))
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function comments(req, env, url) {
  if (!env.COMMENTS) return json({ error: 'Comments are not available.' }, 503)
  const db = env.COMMENTS

  if (req.method === 'GET') {
    const post = url.searchParams.get('post') || ''
    if (!SLUG.test(post)) return json({ error: 'Unknown post.' }, 400)
    const { results } = await db
      .prepare('SELECT id, parent_id AS parent, name, body, created_at AS at FROM comments WHERE post = ? ORDER BY id')
      .bind(post)
      .all()
    return json({ comments: results })
  }

  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)
  if (!/^application\\/json/i.test(req.headers.get('content-type') || '')) {
    return json({ error: 'Expected JSON.' }, 415)
  }
  const raw = await req.text()
  if (raw.length > 16000) return json({ error: 'That comment is too long.' }, 413)
  let input
  try {
    input = JSON.parse(raw)
  } catch (e) {
    return json({ error: 'Expected JSON.' }, 400)
  }
  if (!input || typeof input !== 'object') return json({ error: 'Expected JSON.' }, 400)

  // A field people never see. Bots fill it in; pretend it worked.
  if (input.website) return json({ ok: true }, 201)

  const post = typeof input.post === 'string' ? input.post : ''
  const name = typeof input.name === 'string' ? input.name.trim().replace(/\\s+/g, ' ') : ''
  const body = typeof input.body === 'string' ? input.body.trim().replace(/\\r\\n?/g, '\\n') : ''
  if (!SLUG.test(post)) return json({ error: 'Unknown post.' }, 400)
  if (!name) return json({ error: 'Please add your name.' }, 400)
  if (!body) return json({ error: 'Please write a comment.' }, 400)
  if (name.length > MAX_NAME) return json({ error: 'Please use a shorter name.' }, 400)
  if (body.length > MAX_BODY) return json({ error: 'Please keep comments under ' + MAX_BODY + ' characters.' }, 400)

  // Only published posts take comments: drafts have no page.
  const page = await env.ASSETS.fetch(new Request(new URL('/posts/' + post + '/', url), { method: 'GET' }))
  if (!page.ok) return json({ error: 'Unknown post.' }, 404)

  let parent = null
  if (input.parent != null) {
    const id = Number(input.parent)
    if (!Number.isInteger(id)) return json({ error: 'That comment no longer exists.' }, 404)
    const row = await db.prepare('SELECT id, parent_id, post FROM comments WHERE id = ?').bind(id).first()
    if (!row || row.post !== post) return json({ error: 'That comment no longer exists.' }, 404)
    parent = row.parent_id == null ? row.id : row.parent_id
  }

  const now = Date.now()
  const hash = await ipHash(req)
  const recent = await db
    .prepare('SELECT COUNT(*) AS n FROM comments WHERE ip_hash = ? AND created_at > ?')
    .bind(hash, now - RATE_WINDOW_MS)
    .first()
  if (recent && recent.n >= RATE_MAX) {
    return json({ error: 'You have commented a lot just now. Please wait a few minutes.' }, 429)
  }

  const row = await db
    .prepare(
      'INSERT INTO comments (post, parent_id, name, body, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?) ' +
        'RETURNING id, parent_id AS parent, name, body, created_at AS at',
    )
    .bind(post, parent, name, body, hash, now)
    .first()
  return json({ comment: row }, 201)
}

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function subscribe(req, env) {
  if (!env.COMMENTS) return json({ error: 'Subscribing is not available.' }, 503)
  const db = env.COMMENTS
  const state = await db.prepare('SELECT open FROM newsletter WHERE id = 1').first().catch(() => null)
  const open = !!state && state.open === 1
  if (req.method === 'GET') return json({ open })
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)
  if (!open) return json({ error: 'Subscribing is not available.' }, 404)
  if (!/^application\\/json/i.test(req.headers.get('content-type') || '')) {
    return json({ error: 'Expected JSON.' }, 415)
  }
  const raw = await req.text()
  if (raw.length > 2000) return json({ error: 'Please check your email address.' }, 413)
  let input
  try {
    input = JSON.parse(raw)
  } catch (e) {
    return json({ error: 'Expected JSON.' }, 400)
  }
  if (!input || typeof input !== 'object') return json({ error: 'Expected JSON.' }, 400)
  if (input.website) return json({ ok: true }, 201)

  const email = typeof input.email === 'string' ? input.email.trim() : ''
  if (!email || email.length > MAX_EMAIL || !EMAIL.test(email)) {
    return json({ error: 'Please check your email address.' }, 400)
  }

  const now = Date.now()
  const hash = await ipHash(req)
  const recent = await db
    .prepare('SELECT COUNT(*) AS n FROM subscribers WHERE ip_hash = ? AND created_at > ?')
    .bind(hash, now - RATE_WINDOW_MS)
    .first()
  if (recent && recent.n >= RATE_MAX) {
    return json({ error: 'Too many sign-ups from here just now. Please wait a few minutes.' }, 429)
  }

  await db
    .prepare('INSERT OR IGNORE INTO subscribers (email, token, ip_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind(email, newToken(), hash, now)
    .run()
  return json({ ok: true }, 201)
}

function page(title, body, status) {
  return new Response(
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<meta name="robots" content="noindex, nofollow"><title>' + title + '</title>' +
      '<style>body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:32rem;margin:15vh auto;' +
      'padding:0 20px;line-height:1.5;color:#1f2328;background:#fff}' +
      '@media (prefers-color-scheme:dark){body{color:#e6e6e6;background:#16181c}}' +
      'h1{font-size:1.4rem}a{color:#2563eb}button{font:inherit;padding:9px 18px;border-radius:8px;' +
      'border:0;background:#2563eb;color:#fff;cursor:pointer}</style></head><body><main><h1>' +
      title + '</h1>' + body + '<p><a href="/">Go to the blog</a></p></main></body></html>',
    {
      status: status || 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    },
  )
}

async function unsubscribe(req, env, url) {
  const token = url.searchParams.get('t') || ''
  if (!env.COMMENTS || !TOKEN.test(token)) {
    return page('That link does not work', '<p>Try the unsubscribe link in a newer email.</p>', 400)
  }
  const db = env.COMMENTS
  if (req.method === 'POST') {
    await db.prepare('DELETE FROM subscribers WHERE token = ?').bind(token).run()
    return page('You are unsubscribed', '<p>You will not get any more emails from this blog.</p>')
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return page('Method not allowed', '', 405)
  const row = await db.prepare('SELECT id FROM subscribers WHERE token = ?').bind(token).first()
  if (!row) return page('You are unsubscribed', '<p>This address is not on the list any more.</p>')
  return page(
    'Unsubscribe?',
    '<p>You will stop getting an email when there is a new post.</p>' +
      '<form method="post"><button type="submit">Unsubscribe</button></form>',
  )
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    if (url.pathname === '/api/comments') return comments(req, env, url)
    if (url.pathname === '/api/subscribe') return subscribe(req, env)
    if (url.pathname === '/api/unsubscribe') return unsubscribe(req, env, url)
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
  // Every deploy makes sure the comments database exists, so a blog gains
  // comments and subscriptions at its next publish with no setup step. A token without D1 (a
  // blog from before 0.2 that has not moved yet) still publishes; the page
  // just shows no comment section until it can.
  const commentsDb = await ensureCommentsDatabase(cf, opts.accountId, opts.scriptName).catch(() => null)

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
      ...(commentsDb ? [{ type: 'd1', name: 'COMMENTS', id: commentsDb }] : []),
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
