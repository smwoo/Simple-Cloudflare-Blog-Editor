/**
 * The deployed Worker's comment API, run for real: the source string is
 * imported as a module and given a D1 binding over an in-memory SQLite.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
import { WORKER_SOURCE } from '../deploy.js'
import { COMMENTS_SCHEMA_SQL } from '../comments.js'

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
      }
      return stmt
    },
  }
}

const PUBLISHED = new Set(['/posts/nov-2026/', '/posts/other/'])
const BASE = 'https://alice-blog.alice.workers.dev/api/comments'

let worker: { fetch(req: Request, env: any): Promise<Response> }
let env: any

beforeAll(async () => {
  worker = (await import('data:text/javascript,' + encodeURIComponent(WORKER_SOURCE))).default
})

beforeEach(() => {
  const db = new DatabaseSync(':memory:')
  db.exec(COMMENTS_SCHEMA_SQL)
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
