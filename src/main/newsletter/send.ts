/**
 * Sending a mailing to everyone it has not reached yet.
 *
 * Who has had it is written down after every batch, so stopping partway —
 * Resend's free plan allows 100 a day, a new Cloudflare account fewer — loses
 * nothing: sending again carries on with the next subscriber.
 */
import type { D1 } from '../cloudflare/d1.js'
import {
  getMailing,
  pendingRecipients,
  recordDeliveries,
  finishMailing,
  type Mailing,
  type Subscriber,
} from '../cloudflare/newsletter.js'
import { MailError, batchKey, type Mailer, type OutgoingEmail } from './mail.js'

export interface SendProgress {
  mailingId: number
  sent: number
  total: number
}

export interface SendResult {
  ok: boolean
  mailing: Mailing
  /** Plain language. Set when the send stopped before reaching everyone. */
  message?: string
  /** True when the rest can go later as they are: a limit or a busy service, not a setup problem. */
  resumable?: boolean
  log?: string
}

const BUSY_RETRIES = 4

export async function sendMailing(
  d1: D1,
  mailer: Mailer,
  mailingId: number,
  compose: (subscriber: Subscriber) => OutgoingEmail,
  onProgress: (p: SendProgress) => void = () => {},
  opts: { sleep?: (ms: number) => Promise<void>; backoffMs?: number } = {},
): Promise<SendResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const backoffMs = opts.backoffMs ?? 2000
  const start = await getMailing(d1, mailingId)
  if (!start) throw new Error(`no mailing ${mailingId}`)

  let sent = start.sent
  const total = start.total
  onProgress({ mailingId, sent, total })
  let busy = 0

  for (;;) {
    const pending = await pendingRecipients(d1, mailingId, mailer.batchSize * mailer.parallel)
    if (!pending.length) break

    const batches: Subscriber[][] = []
    for (let i = 0; i < pending.length; i += mailer.batchSize) batches.push(pending.slice(i, i + mailer.batchSize))

    const results = await Promise.allSettled(
      batches.map((b) => mailer.send(b.map(compose), batchKey(mailingId, b.map((s) => s.id)))),
    )
    const delivered = batches.filter((_, i) => results[i].status === 'fulfilled').flat()
    await recordDeliveries(d1, mailingId, delivered.map((s) => s.id))
    sent += delivered.length
    onProgress({ mailingId, sent, total })

    const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (!failure) {
      busy = 0
      continue
    }
    const err =
      failure.reason instanceof MailError
        ? failure.reason
        : new MailError('The email could not be sent.', 'failed', String(failure.reason))

    if (err.kind === 'busy' && busy < BUSY_RETRIES) {
      await sleep(backoffMs * 2 ** busy++)
      continue
    }
    const mailing = (await getMailing(d1, mailingId))!
    return {
      ok: false,
      mailing,
      message: err.message,
      resumable: err.kind === 'busy' || err.kind === 'limit',
      log: err.log,
    }
  }

  await finishMailing(d1, mailingId)
  return { ok: true, mailing: (await getMailing(d1, mailingId))! }
}
