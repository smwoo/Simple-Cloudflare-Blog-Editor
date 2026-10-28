/**
 * Writing a newsletter email and handing it to a sending service.
 *
 * Two services, because neither is the obvious choice:
 *
 * - **Cloudflare Email Sending** keeps the blog on one service and uses the
 *   token the app already holds. It needs the Workers Paid plan ($5 a month,
 *   3,000 emails included), was in beta when this was written, sends one
 *   email per request, and starts new accounts on a low daily limit.
 * - **Resend** is free up to 100 emails a day and 3,000 a month, and takes 100
 *   emails per request, but it is a second account and a key to paste in.
 *
 * Both need the sending address's domain set up with the service first, which
 * is done in their dashboards. Sending from a workers.dev address is not
 * possible with either.
 *
 * Each email is addressed to one subscriber, never a list: it carries that
 * person's own unsubscribe link, and nobody sees anyone else's address.
 */
import { createHash } from 'node:crypto'
import { CloudflareError, type CloudflareClient } from '../cloudflare/api.js'

export type Provider = 'cloudflare' | 'resend'

export interface Sender {
  provider: Provider
  fromEmail: string
  /** Shown as the sender, e.g. "Alice's blog". Resend only: Cloudflare's API takes a bare address. */
  fromName?: string
}

export interface OutgoingEmail {
  to: string
  subject: string
  html: string
  text: string
  headers: Record<string, string>
}

/**
 * `busy`:  the service asked us to slow down; worth waiting and trying again.
 * `limit`: a daily or monthly allowance is used up; the rest can go later.
 * `setup`: something the owner (or their helper) has to fix first.
 * `failed`: anything else.
 */
export type MailErrorKind = 'busy' | 'limit' | 'setup' | 'failed'

export class MailError extends Error {
  constructor(
    message: string,
    readonly kind: MailErrorKind,
    readonly log?: string,
  ) {
    super(message)
    this.name = 'MailError'
  }
}

export interface Mailer {
  /** Emails per request. */
  batchSize: number
  /** Requests in flight at once. */
  parallel: number
  /** Sends every email in the batch, or throws a MailError for the whole batch. */
  send(batch: OutgoingEmail[], idempotencyKey: string): Promise<void>
}

/** A stable key for a batch, so a retried request is not sent twice. */
export function batchKey(mailingId: number | string, subscriberIds: number[]): string {
  return createHash('sha256').update(`${mailingId}:${subscriberIds.join(',')}`).digest('hex')
}

// ---------------------------------------------------------------- the email

export interface Content {
  blogTitle: string
  subject: string
  /** Plain text the owner wrote. Blank lines separate paragraphs. */
  body: string
  /** A button under the text, e.g. to the new post. */
  link?: string | null
  linkLabel?: string
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * One subscriber's copy. Inline styles and a single table, because email
 * clients ignore style sheets; no images, because photos on the blog are AVIF
 * and many mail apps cannot show it.
 */
export function renderEmail(c: Content, to: string, unsubscribeUrl: string): OutgoingEmail {
  const paragraphs = c.body
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n\s*\n/)
    .filter((p) => p.trim())
  const label = c.linkLabel ?? 'Read it on the blog'

  const font = 'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif'
  const html =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"></head>` +
    `<body style="margin:0;padding:0;background:#f6f6f4">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f4">` +
    `<tr><td align="center" style="padding:32px 16px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ` +
    `style="max-width:560px;background:#ffffff;border-radius:10px">` +
    `<tr><td style="padding:28px 32px;${font};color:#1f2328;font-size:16px;line-height:1.55">` +
    `<p style="margin:0 0 18px;font-size:13px;color:#6b7280">${escapeHtml(c.blogTitle)}</p>` +
    `<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3">${escapeHtml(c.subject)}</h1>` +
    paragraphs
      .map((p) => `<p style="margin:0 0 14px">${escapeHtml(p.trim()).replace(/\n/g, '<br>')}</p>`)
      .join('') +
    (c.link
      ? `<p style="margin:22px 0 4px"><a href="${escapeHtml(c.link)}" ` +
        `style="display:inline-block;padding:10px 20px;background:#2563eb;color:#ffffff;` +
        `text-decoration:none;border-radius:8px">${escapeHtml(label)}</a></p>`
      : '') +
    `</td></tr></table>` +
    `<p style="${font};font-size:12px;color:#6b7280;max-width:560px;margin:16px auto 0">` +
    `You get this because you subscribed to ${escapeHtml(c.blogTitle)}. ` +
    `<a href="${escapeHtml(unsubscribeUrl)}" style="color:#6b7280">Unsubscribe</a></p>` +
    `</td></tr></table></body></html>`

  const text =
    `${c.subject}\n\n` +
    paragraphs.map((p) => p.trim()).join('\n\n') +
    (c.link ? `\n\n${label}: ${c.link}` : '') +
    `\n\n--\nYou get this because you subscribed to ${c.blogTitle}.\nUnsubscribe: ${unsubscribeUrl}\n`

  return {
    to,
    subject: c.subject,
    html,
    text,
    // One-click unsubscribe (RFC 8058): Gmail and Apple Mail show their own
    // button, and large senders' mail is expected to carry it.
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  }
}

// ---------------------------------------------------------------- Cloudflare

const CF_SETUP: Record<number, string> = {
  10101: 'Cloudflare did not accept the token for sending email.',
  10102: 'Your Cloudflare token cannot send email. Add the "Email Sending — Edit" permission to it.',
  10105: 'Sending email from Cloudflare needs the Workers Paid plan on your Cloudflare account.',
  10203: 'Email sending is turned off for this address in Cloudflare. Check Email Service in the dashboard.',
  10207: 'Cloudflare has paused email sending for your account. Check Email Service in the dashboard.',
}

export class CloudflareMailer implements Mailer {
  readonly batchSize = 1
  readonly parallel = 4

  constructor(
    private cf: CloudflareClient,
    private accountId: string,
    private sender: Sender,
  ) {}

  async send(batch: OutgoingEmail[]): Promise<void> {
    for (const email of batch) {
      try {
        await this.cf.request(`/accounts/${this.accountId}/email/sending/send`, {
          method: 'POST',
          body: JSON.stringify({
            from: this.sender.fromEmail,
            to: email.to,
            subject: email.subject,
            html: email.html,
            text: email.text,
            headers: email.headers,
          }),
        })
      } catch (e) {
        throw cloudflareMailError(e, this.sender.fromEmail)
      }
    }
  }
}

export function cloudflareMailError(e: unknown, from: string): MailError {
  if (!(e instanceof CloudflareError)) {
    return new MailError('Cloudflare could not be reached. Check the internet connection.', 'failed', String(e))
  }
  const log = `${e.status} ${e.code ?? ''} ${e.message}`
  if (e.status === 429) return new MailError('Cloudflare is not taking more emails just now.', 'busy', log)
  if (e.code && CF_SETUP[e.code]) return new MailError(CF_SETUP[e.code], 'setup', log)
  if (e.status === 401 || e.status === 403) {
    return new MailError(
      `Cloudflare would not send from ${from}. Check the address's domain is set up under ` +
        `Email Service → Email Sending, and the token has "Email Sending — Edit".`,
      'setup',
      log,
    )
  }
  if (/limit|quota/i.test(e.message)) {
    return new MailError('Cloudflare\'s daily email limit for your account is used up.', 'limit', log)
  }
  if (e.status === 400) {
    return new MailError(
      `Cloudflare would not send this email. Check ${from} is on a domain set up for Email Sending.`,
      'setup',
      log,
    )
  }
  return new MailError('Cloudflare could not send the email just now.', 'failed', log)
}

// ---------------------------------------------------------------- Resend

type FetchFn = (url: string, init: RequestInit) => Promise<Response>

export class ResendMailer implements Mailer {
  readonly batchSize = 100
  // Resend allows a few requests a second; one at a time stays well inside it.
  readonly parallel = 1

  constructor(
    private apiKey: string,
    private sender: Sender,
    private fetchFn: FetchFn = fetch,
  ) {}

  private get from() {
    const name = this.sender.fromName?.replace(/["\\<>\r\n]/g, '').trim()
    return name ? `"${name}" <${this.sender.fromEmail}>` : this.sender.fromEmail
  }

  async send(batch: OutgoingEmail[], idempotencyKey: string): Promise<void> {
    let res: Response
    try {
      res = await this.fetchFn('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(
          batch.map((e) => ({
            from: this.from,
            to: [e.to],
            subject: e.subject,
            html: e.html,
            text: e.text,
            headers: e.headers,
          })),
        ),
      })
    } catch (e) {
      throw new MailError('Resend could not be reached. Check the internet connection.', 'failed', String(e))
    }
    if (res.ok) return
    const body = (await res.json().catch(() => ({}))) as { name?: string; message?: string }
    throw resendMailError(res.status, body, this.sender.fromEmail)
  }
}

export function resendMailError(status: number, body: { name?: string; message?: string }, from: string): MailError {
  const log = `${status} ${body.name ?? ''} ${body.message ?? ''}`
  switch (body.name) {
    case 'rate_limit_exceeded':
    case 'concurrent_idempotent_requests':
      return new MailError('Resend is not taking more emails just now.', 'busy', log)
    case 'daily_quota_exceeded':
      return new MailError(
        'Resend\'s daily email limit is used up (100 a day on the free plan). It resets at midnight UTC.',
        'limit',
        log,
      )
    case 'monthly_quota_exceeded':
      return new MailError('Resend\'s monthly email limit is used up.', 'limit', log)
    case 'missing_api_key':
    case 'restricted_api_key':
    case 'suspended_api_key':
    case 'invalid_api_key':
      return new MailError('Resend did not accept the API key. Paste a key with permission to send.', 'setup', log)
  }
  if (status === 403 && /not verified/i.test(body.message ?? '')) {
    return new MailError(
      `The domain of ${from} is not verified in Resend yet. Finish it under Domains in Resend.`,
      'setup',
      log,
    )
  }
  if (status === 401 || status === 403) {
    return new MailError(body.message || 'Resend would not send from this address.', 'setup', log)
  }
  if (status === 429) return new MailError('Resend is not taking more emails just now.', 'busy', log)
  if (status === 400 || status === 422) {
    return new MailError(body.message || 'Resend would not send this email.', 'setup', log)
  }
  return new MailError('Resend could not send the email just now.', 'failed', log)
}
