/**
 * How the newsletter is sent: the service, the sending address and, for
 * Resend, its key.
 *
 * Kept in the shared database beside the storage keys, so every computer
 * sends the same way without the owner setting it up twice, and the Worker,
 * which never binds that database, cannot read the key.
 */
import type { D1 } from '../cloudflare/d1.js'
import { NOW_MS } from '../sync/schema.js'
import type { Provider, Sender } from './mail.js'

export const SENDER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS newsletter_sender (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider TEXT NOT NULL,
  from_email TEXT NOT NULL,
  from_name TEXT,
  resend_key TEXT,
  updated_at INTEGER NOT NULL
);
`

export interface SenderSettings extends Sender {
  resendKey?: string
}

/** The table arrived after the shared database did, so it is made on first use. */
const ready = new WeakSet<D1>()
async function ensure(d1: D1) {
  if (ready.has(d1)) return
  await d1.exec(SENDER_SCHEMA_SQL)
  ready.add(d1)
}

export async function readSender(d1: D1): Promise<SenderSettings | null> {
  await ensure(d1)
  const { rows } = await d1.query<{
    provider: Provider
    from_email: string
    from_name: string | null
    resend_key: string | null
  }>(`SELECT provider, from_email, from_name, resend_key FROM newsletter_sender WHERE id = 1`)
  const r = rows[0]
  if (!r) return null
  return {
    provider: r.provider,
    fromEmail: r.from_email,
    ...(r.from_name ? { fromName: r.from_name } : {}),
    ...(r.resend_key ? { resendKey: r.resend_key } : {}),
  }
}

/** `resendKey` left undefined keeps the stored one, so the owner need not paste it again. */
export async function writeSender(d1: D1, s: SenderSettings): Promise<void> {
  await ensure(d1)
  await d1.query(
    `INSERT INTO newsletter_sender (id, provider, from_email, from_name, resend_key, updated_at)
       VALUES (1, ?, ?, ?, ?, ${NOW_MS})
     ON CONFLICT(id) DO UPDATE SET
       provider = excluded.provider, from_email = excluded.from_email, from_name = excluded.from_name,
       resend_key = COALESCE(excluded.resend_key, newsletter_sender.resend_key),
       updated_at = excluded.updated_at`,
    [s.provider, s.fromEmail.trim(), s.fromName?.trim() || null, s.resendKey?.trim() || null],
  )
}
