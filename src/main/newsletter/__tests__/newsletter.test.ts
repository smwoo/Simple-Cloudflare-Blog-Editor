/**
 * The newsletter from the app's side: the subscriber list, mailings that
 * carry on where they stopped, and what each email says.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { FakeD1 } from '../../sync/__tests__/fakeD1.js'
import {
  NEWSLETTER_SCHEMA_SQL,
  addSubscriber,
  listSubscribers,
  removeSubscriber,
  createMailing,
  announcedPosts,
  forgetPost,
  getMailing,
  isOpen,
  setOpen,
} from '../../cloudflare/newsletter.js'
import { sendMailing } from '../send.js'
import { MailError, renderEmail, resendMailError, ResendMailer, type Mailer, type OutgoingEmail } from '../mail.js'
import { readSender, writeSender } from '../settings.js'

let d1: FakeD1

beforeEach(async () => {
  d1 = new FakeD1()
  await d1.exec(NEWSLETTER_SCHEMA_SQL)
})

/** Subscribers created a moment ago, so a mailing made now includes them. */
async function subscribe(...emails: string[]) {
  for (const e of emails) {
    await d1.query(`INSERT INTO subscribers (email, token, created_at) VALUES (?, ?, 0)`, [e, e.padEnd(32, '0')])
  }
}

/** Records what it was asked to send; fails on cue. */
class FakeMailer implements Mailer {
  sent: OutgoingEmail[] = []
  keys: string[] = []
  failWith: MailError[] = []
  constructor(
    readonly batchSize = 2,
    readonly parallel = 1,
  ) {}
  async send(batch: OutgoingEmail[], key: string) {
    const err = this.failWith.shift()
    if (err) throw err
    this.sent.push(...batch)
    this.keys.push(key)
  }
}

const compose = (s: { email: string; token: string }): OutgoingEmail =>
  renderEmail({ blogTitle: 'Blog', subject: 'Hi', body: 'x' }, s.email, `https://b.example/api/unsubscribe?t=${s.token}`)

const noSleep = { sleep: async () => {} }

describe('subscribers', () => {
  it('adds an address once, whatever its case, and removes it', async () => {
    expect(await addSubscriber(d1, 'Bob@Example.com')).toBe(true)
    expect(await addSubscriber(d1, 'bob@example.com ')).toBe(false)
    const [bob] = await listSubscribers(d1)
    expect(bob.email).toBe('Bob@Example.com')
    expect(bob.token).toMatch(/^[0-9a-f]{32}$/)
    await removeSubscriber(d1, bob.id)
    expect(await listSubscribers(d1)).toEqual([])
  })

  it('keeps the box hidden until it is turned on', async () => {
    expect(await isOpen(d1)).toBe(false)
    await setOpen(d1, true)
    expect(await isOpen(d1)).toBe(true)
    await setOpen(d1, false)
    expect(await isOpen(d1)).toBe(false)
  })
})

describe('sending a mailing', () => {
  it('sends one email to each subscriber, in batches, then marks it finished', async () => {
    await subscribe('a@x.com', 'b@x.com', 'c@x.com')
    const m = await createMailing(d1, { subject: 'Hi', body: 'x' })
    const mailer = new FakeMailer(2)
    const res = await sendMailing(d1, mailer, m.id, compose, undefined, noSleep)
    expect(res.ok).toBe(true)
    expect(mailer.sent.map((e) => e.to)).toEqual(['a@x.com', 'b@x.com', 'c@x.com'])
    expect(mailer.keys).toHaveLength(2)
    expect(res.mailing).toMatchObject({ sent: 3, total: 3 })
    expect(res.mailing.finishedAt).not.toBeNull()
  })

  it('stops at a limit and carries on later with only the people it missed', async () => {
    await subscribe('a@x.com', 'b@x.com', 'c@x.com', 'd@x.com')
    const m = await createMailing(d1, { subject: 'Hi', body: 'x' })
    // The first batch goes; the second hits the day's limit.
    const today = new FakeMailer(2)
    const limited: Mailer = {
      batchSize: 2,
      parallel: 1,
      async send(batch, key) {
        if (today.sent.length) throw new MailError('Daily limit used up.', 'limit')
        await today.send(batch, key)
      },
    }
    const stopped = await sendMailing(d1, limited, m.id, compose, undefined, noSleep)
    expect(stopped).toMatchObject({ ok: false, resumable: true, message: 'Daily limit used up.' })
    expect(stopped.mailing).toMatchObject({ sent: 2, total: 4, finishedAt: null })

    const tomorrow = new FakeMailer(2)
    const res = await sendMailing(d1, tomorrow, m.id, compose, undefined, noSleep)
    expect(res.ok).toBe(true)
    expect(tomorrow.sent.map((e) => e.to)).toEqual(['c@x.com', 'd@x.com'])
  })

  it('waits and tries again when the service is busy', async () => {
    await subscribe('a@x.com')
    const m = await createMailing(d1, { subject: 'Hi', body: 'x' })
    const mailer = new FakeMailer()
    mailer.failWith = [new MailError('busy', 'busy'), new MailError('busy', 'busy')]
    const waits: number[] = []
    const res = await sendMailing(d1, mailer, m.id, compose, undefined, {
      sleep: async (ms) => void waits.push(ms),
      backoffMs: 10,
    })
    expect(res.ok).toBe(true)
    expect(waits).toEqual([10, 20])
  })

  it('gives up on a setup problem without calling it resumable', async () => {
    await subscribe('a@x.com')
    const m = await createMailing(d1, { subject: 'Hi', body: 'x' })
    const mailer = new FakeMailer()
    mailer.failWith = [new MailError('Domain not verified.', 'setup')]
    const res = await sendMailing(d1, mailer, m.id, compose, undefined, noSleep)
    expect(res).toMatchObject({ ok: false, resumable: false, message: 'Domain not verified.' })
  })

  it('leaves out people who subscribed after it was written, and anyone who left', async () => {
    await subscribe('a@x.com', 'b@x.com')
    const m = await createMailing(d1, { subject: 'Hi', body: 'x' })
    await d1.query(`INSERT INTO subscribers (email, token, created_at) VALUES ('late@x.com', 't', ?)`, [
      Date.now() + 60_000,
    ])
    await d1.query(`DELETE FROM subscribers WHERE email = 'b@x.com'`)
    const mailer = new FakeMailer()
    const res = await sendMailing(d1, mailer, m.id, compose, undefined, noSleep)
    expect(mailer.sent.map((e) => e.to)).toEqual(['a@x.com'])
    expect(res.mailing).toMatchObject({ sent: 1, total: 1 })
  })

  it('makes a post’s email once: asking again resumes the same one', async () => {
    await subscribe('a@x.com')
    const first = await createMailing(d1, { post: 'nov', subject: 'Nov', body: 'x', link: 'https://b/posts/nov/' })
    const again = await createMailing(d1, { post: 'nov', subject: 'Nov', body: 'x' })
    expect(again.id).toBe(first.id)
    const other = await createMailing(d1, { subject: 'Hello', body: 'x' })
    expect(other.id).not.toBe(first.id)
    expect(await announcedPosts(d1)).toEqual(['nov'])
    expect((await getMailing(d1, first.id))?.link).toBe('https://b/posts/nov/')
  })

  it('lets a new post with a deleted post’s name have its own email', async () => {
    const old = await createMailing(d1, { post: 'nov', subject: 'Nov', body: 'x' })
    await forgetPost(d1, 'nov')
    expect(await announcedPosts(d1)).toEqual([])
    const fresh = await createMailing(d1, { post: 'nov', subject: 'Nov again', body: 'y' })
    expect(fresh.id).not.toBe(old.id)
    expect((await getMailing(d1, old.id))?.subject).toBe('Nov')
  })
})

describe('the email', () => {
  it('escapes what the owner wrote and carries a one-click unsubscribe', () => {
    const e = renderEmail(
      { blogTitle: 'Al & Bo', subject: '<b>Hi</b>', body: 'One\nline\n\nTwo', link: 'https://b/posts/x/', linkLabel: 'Read' },
      'a@x.com',
      'https://b/api/unsubscribe?t=abc',
    )
    expect(e.to).toBe('a@x.com')
    expect(e.html).toContain('Al &amp; Bo')
    expect(e.html).toContain('&lt;b&gt;Hi&lt;/b&gt;')
    expect(e.html).not.toContain('<b>Hi</b>')
    expect(e.html).toContain('One<br>line</p>')
    expect(e.html).toContain('href="https://b/api/unsubscribe?t=abc"')
    expect(e.text).toContain('Read: https://b/posts/x/')
    expect(e.text).toContain('Unsubscribe: https://b/api/unsubscribe?t=abc')
    expect(e.headers).toEqual({
      'List-Unsubscribe': '<https://b/api/unsubscribe?t=abc>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    })
  })
})

describe('sending services', () => {
  it('sends a Resend batch with the key, sender name and idempotency key', async () => {
    let req: { url: string; init: RequestInit } | null = null
    const mailer = new ResendMailer('re_k', { fromEmail: 'n@al.com', fromName: 'Al "Blog"' }, async (url, init) => {
      req = { url, init }
      return new Response('{"data":[]}', { status: 200 })
    })
    await mailer.send([compose({ email: 'a@x.com', token: 't' })], 'key-1')
    expect(req!.url).toBe('https://api.resend.com/emails/batch')
    const headers = req!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer re_k')
    expect(headers['Idempotency-Key']).toBe('key-1')
    const [email] = JSON.parse(req!.init.body as string)
    expect(email).toMatchObject({ from: '"Al Blog" <n@al.com>', to: ['a@x.com'], subject: 'Hi' })
    expect(email.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
  })

  it('tells a used-up allowance from a setup problem', () => {
    expect(resendMailError(429, { name: 'daily_quota_exceeded' }, 'n@al.com').kind).toBe('limit')
    expect(resendMailError(429, { name: 'rate_limit_exceeded' }, 'n@al.com').kind).toBe('busy')
    const unverified = resendMailError(403, { name: 'validation_error', message: 'The al.com domain is not verified.' }, 'n@al.com')
    expect(unverified.kind).toBe('setup')
    expect(unverified.message).toMatch(/not verified in Resend/)

    expect(resendMailError(401, { name: 'restricted_api_key' }, 'n@al.com').kind).toBe('setup')
  })
})

describe('sending settings', () => {
  it('needs a Resend key, and keeps the saved one when it is not given again', async () => {
    expect(await readSender(d1)).toBeNull()
    expect(await writeSender(d1, { fromEmail: 'n@al.com' })).toBe(false)
    expect(await readSender(d1)).toBeNull()
    expect(await writeSender(d1, { fromEmail: ' n@al.com ', fromName: 'Al', resendKey: 're_1' })).toBe(true)
    expect(await writeSender(d1, { fromEmail: 'news@al.com', fromName: '' })).toBe(true)
    expect(await readSender(d1)).toEqual({ fromEmail: 'news@al.com', resendKey: 're_1' })
    await writeSender(d1, { fromEmail: 'news@al.com', resendKey: 're_2' })
    expect((await readSender(d1))?.resendKey).toBe('re_2')
  })
})
