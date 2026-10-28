/**
 * The deployed Worker's comment and newsletter APIs, run for real: the source string is
 * imported as a module and given a D1 binding over an in-memory SQLite.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
import { WORKER_SOURCE } from '../deploy.js'
import { COMMENTS_SCHEMA_SQL } from '../comments.js'
import { NEWSLETTER_SCHEMA_SQL } from '../newsletter.js'

// Loaded through require: Vite does not yet know node:sqlite is a builtin.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

/** Just the slice of Cloudflare's D1 binding the Worker uses. */
function d1Binding(db: InstanceType<typeof DatabaseSync>) {
  return {
    prepare(sql: string) {
      let params: any[] = []
      const stmt = {
        bind(...p: any[]) {
          params = p
          return stmt
        },
        async all() {
          return { results: db.prepare(sql).all(...params) }
        },
        async first() {
          return db.prepare(sql).get(...params) ?? null
        },
        async run() {
          return { meta: { changes: Number(db.prepare(sql).run(...params).changes) } }
        },
      }
      return stmt
    },
  }
}

const PUBLISHED = new Set(['/posts/nov-2026/', '/posts/other/'])
const BASE = 'https://alice-blog.alice.workers.dev/api/comments'

let worker: { fetch(req: Request, env: any): Promise<Response> }
let env: any
let sqlite: InstanceType<typeof DatabaseSync>

beforeAll(async () => {
  worker = (await import('data:text/javascript,' + encodeURIComponent(WORKER_SOURCE))).default
})

beforeEach(() => {
  const db = new DatabaseSync(':memory:')
  db.exec(COMMENTS_SCHEMA_SQL + NEWSLETTER_SCHEMA_SQL)
  sqlite = db
  env = {
    COMMENTS: d1Binding(db),
    ASSETS: {
      fetch: async (req: Request) =>
        new Response('page', { status: PUBLISHED.has(new URL(req.url).pathname) ? 200 : 404 }),
    },
  }
})

const post = (body: object, ip = '1.2.3.4') =>
  worker.fetch(
    new Request(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
      body: JSON.stringify(body),
    }),
    env,
  )

const added = async (body: object) => ((await (await post(body)).json()) as any).comment

const list = async (slug = 'nov-2026') =>
  ((await (await worker.fetch(new Request(`${BASE}?post=${slug}`), env)).json()) as any).comments

describe('comments API', () => {
  it('adds a comment and lists it with its name, text and time', async () => {
    const res = await post({ post: 'nov-2026', name: '  Bob  ', body: ' Lovely photos!\r\nMore please ' })
    expect(res.status).toBe(201)
    const { comment } = (await res.json()) as any
    expect(comment).toMatchObject({ parent: null, name: 'Bob', body: 'Lovely photos!\nMore please' })
    expect(typeof comment.at).toBe('number')
    expect(await list()).toEqual([comment])
    expect(await list('other')).toEqual([])
  })

  it('keeps one level of replies: a reply to a reply joins the top comment', async () => {
    const top = await added({ post: 'nov-2026', name: 'Bob', body: 'Hi' })
    const r1 = await added({ post: 'nov-2026', name: 'Cy', body: 'Hey', parent: top.id })
    const r2 = await added({ post: 'nov-2026', name: 'Di', body: 'Yo', parent: r1.id })
    expect(r1.parent).toBe(top.id)
    expect(r2.parent).toBe(top.id)
    expect((await list()).map((c: any) => [c.name, c.parent])).toEqual([
      ['Bob', null],
      ['Cy', top.id],
      ['Di', top.id],
    ])
  })

  it('refuses a reply to a comment on another post, or one that does not exist', async () => {
    const top = await added({ post: 'other', name: 'Bob', body: 'Hi' })
    expect((await post({ post: 'nov-2026', name: 'Cy', body: 'x', parent: top.id })).status).toBe(404)
    expect((await post({ post: 'nov-2026', name: 'Cy', body: 'x', parent: 999 })).status).toBe(404)
  })

  it('needs a name and a comment, within limits', async () => {
    expect((await post({ post: 'nov-2026', name: ' ', body: 'x' })).status).toBe(400)
    expect((await post({ post: 'nov-2026', name: 'Bob', body: '  ' })).status).toBe(400)
    expect((await post({ post: 'nov-2026', name: 'B'.repeat(61), body: 'x' })).status).toBe(400)
    expect((await post({ post: 'nov-2026', name: 'Bob', body: 'x'.repeat(2001) })).status).toBe(400)
    expect(await list()).toEqual([])
  })

  it('only takes comments on published posts', async () => {
    expect((await post({ post: 'a-draft', name: 'Bob', body: 'x' })).status).toBe(404)
    expect((await post({ post: '../etc', name: 'Bob', body: 'x' })).status).toBe(400)
  })

  it('demands JSON, so a form on another site cannot post', async () => {
    const res = await worker.fetch(
      new Request(BASE, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'post=nov-2026&name=Bob&body=x',
      }),
      env,
    )
    expect(res.status).toBe(415)
  })

  it('quietly drops what a bot puts in the hidden field', async () => {
    expect((await post({ post: 'nov-2026', name: 'Bot', body: 'buy', website: 'spam.example' })).status).toBe(201)
    expect(await list()).toEqual([])
  })

  it('limits how fast one address can comment', async () => {
    for (let i = 0; i < 5; i++) expect((await post({ post: 'nov-2026', name: 'Bob', body: `${i}` })).status).toBe(201)
    expect((await post({ post: 'nov-2026', name: 'Bob', body: 'again' })).status).toBe(429)
    expect((await post({ post: 'nov-2026', name: 'Cy', body: 'me too' }, '5.6.7.8')).status).toBe(201)
  })

  it('answers 503 when the blog has no comments database', async () => {
    delete env.COMMENTS
    expect((await worker.fetch(new Request(`${BASE}?post=nov-2026`), env)).status).toBe(503)
  })

  it('leaves pages to the static assets', async () => {
    expect((await worker.fetch(new Request('https://x.dev/posts/nov-2026/'), env)).status).toBe(200)
  })
})

const SITE = 'https://alice-blog.alice.workers.dev'

const subscribe = (body: object | string, ip = '1.2.3.4', type = 'application/json') =>
  worker.fetch(
    new Request(`${SITE}/api/subscribe`, {
      method: 'POST',
      headers: { 'content-type': type, 'cf-connecting-ip': ip },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
  )

const emails = () => (sqlite.prepare('SELECT email FROM subscribers ORDER BY id').all() as any[]).map((r) => r.email)
const tokenOf = (email: string) => (sqlite.prepare('SELECT token FROM subscribers WHERE email = ?').get(email) as any).token
const open = () => sqlite.exec('INSERT INTO newsletter (id, open) VALUES (1, 1)')

describe('subscribe API', () => {
  it('says whether the box is on, and takes nobody while it is off', async () => {
    const state = async () => ((await (await worker.fetch(new Request(`${SITE}/api/subscribe`), env)).json()) as any).open
    expect(await state()).toBe(false)
    expect((await subscribe({ email: 'bob@example.com' })).status).toBe(404)
    open()
    expect(await state()).toBe(true)
    expect(emails()).toEqual([])
  })

  it('adds an address once and answers the same the second time', async () => {
    open()
    expect((await subscribe({ email: '  bob@example.com ' })).status).toBe(201)
    const again = await subscribe({ email: 'BOB@example.com' }, '5.6.7.8')
    expect(again.status).toBe(201)
    expect(await again.json()).toEqual({ ok: true })
    expect(emails()).toEqual(['bob@example.com'])
    expect(tokenOf('bob@example.com')).toMatch(/^[0-9a-f]{32}$/)
  })

  it('refuses what is not an email address, a form post, and a bot', async () => {
    open()
    expect((await subscribe({ email: 'bob' })).status).toBe(400)
    expect((await subscribe({ email: 'a@b.c'.padStart(260, 'x') })).status).toBe(400)
    expect((await subscribe('email=bob@example.com', '1.2.3.4', 'application/x-www-form-urlencoded')).status).toBe(415)
    expect((await subscribe({ email: 'bot@example.com', website: 'spam.example' })).status).toBe(201)
    expect(emails()).toEqual([])
  })

  it('limits how many addresses one place can sign up', async () => {
    open()
    for (let i = 0; i < 5; i++) expect((await subscribe({ email: `p${i}@example.com` })).status).toBe(201)
    expect((await subscribe({ email: 'p5@example.com' })).status).toBe(429)
    expect((await subscribe({ email: 'p5@example.com' }, '9.9.9.9')).status).toBe(201)
  })
})

describe('unsubscribe link', () => {
  const link = (t: string, init?: RequestInit) =>
    worker.fetch(new Request(`${SITE}/api/unsubscribe?t=${t}`, init), env)

  beforeEach(async () => {
    open()
    await subscribe({ email: 'bob@example.com' })
  })

  it('only asks when opened, since mail scanners open links', async () => {
    const res = await link(tokenOf('bob@example.com'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    expect(await res.text()).toContain('<form method="post">')
    expect(emails()).toEqual(['bob@example.com'])
  })

  it('removes the address on the button, or on a mail app\'s one-click POST', async () => {
    const token = tokenOf('bob@example.com')
    const res = await link(token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('You are unsubscribed')
    expect(emails()).toEqual([])
    // Opening the link again does no harm.
    expect(await (await link(token)).text()).toContain('not on the list')
  })

  it('turns away a malformed token', async () => {
    expect((await link('<script>')).status).toBe(400)
    expect((await link('0'.repeat(32), { method: 'POST' })).status).toBe(200)
    expect(emails()).toEqual(['bob@example.com'])
  })
})
