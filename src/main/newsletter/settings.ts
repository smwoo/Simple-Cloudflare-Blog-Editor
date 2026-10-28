/**
 * How the newsletter is sent: the sending address and the Resend key.
 *
 * Kept in the shared database beside the storage keys, so every computer
 * sends the same way without the owner setting it up twice, and the Worker,
 * which never binds that database, cannot read the key.
 */
import type { D1 } from '../cloudflare/d1.js'
import { NOW_MS } from '../sync/schema.js'
import type { Sender } from './mail.js'

export const SENDER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS newsletter_sender (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  from_email TEXT NOT NULL,
  from_name TEXT,
  resend_key TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`

export interface SenderSettings extends Sender {
  resendKey: string
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
  const { rows } = await d1.query<{ from_email: string; from_name: string | null; resend_key: string }>(
    `SELECT from_email, from_name, resend_key FROM newsletter_sender WHERE id = 1`,
  )
  const r = rows[0]
  if (!r) return null
  return {
    fromEmail: r.from_email,
    ...(r.from_name ? { fromName: r.from_name } : {}),
    resendKey: r.resend_key,
  }
}

/**
 * `resendKey` left empty keeps the stored one, so the owner need not paste it
 * again. Returns false when there is no key, given or stored.
 */
export async function writeSender(
  d1: D1,
  s: Sender & { resendKey?: string },
): Promise<boolean> {
  await ensure(d1)
  const { changes } = await d1.query(
    `INSERT INTO newsletter_sender (id, from_email, from_name, resend_key, updated_at)
       SELECT 1, ?, ?, key, ${NOW_MS}
         FROM (SELECT COALESCE(?, (SELECT resend_key FROM newsletter_sender WHERE id = 1)) AS key)
        WHERE key IS NOT NULL
     ON CONFLICT(id) DO UPDATE SET
       from_email = excluded.from_email, from_name = excluded.from_name,
       resend_key = excluded.resend_key, updated_at = excluded.updated_at`,
    [s.fromEmail.trim(), s.fromName?.trim() || null, s.resendKey?.trim() || null],
  )
  return changes > 0
}
