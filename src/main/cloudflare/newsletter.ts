/**
 * The newsletter's data: who subscribed, and which emails reached whom.
 *
 * It lives in the visitors' database beside comments, because visitors write
 * to it: the Worker adds a subscriber from the box under each post and removes
 * one from an unsubscribe link. How email is sent (and the key to send it) is
 * the owner's business and stays in the shared database, which the Worker
 * never binds.
 *
 * Every email is a mailing, and every subscriber it reached is a delivery. A
 * send that stops partway — a daily limit, a dropped connection — picks up
 * where it left off, and a new-post email exists at most once per post, so two
 * computers can never both announce it.
 */
import { randomBytes } from 'node:crypto'
import type { D1 } from './d1.js'
import { NOW_MS } from '../sync/schema.js'

export const NEWSLETTER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  token TEXT NOT NULL UNIQUE,
  ip_hash TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS subscribers_ip ON subscribers(ip_hash, created_at);
CREATE TABLE IF NOT EXISTS newsletter (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  open INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS mailings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post TEXT UNIQUE,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS deliveries (
  mailing_id INTEGER NOT NULL,
  subscriber_id INTEGER NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (mailing_id, subscriber_id)
);
`

/** The same shape check the Worker makes. Deliberately loose: the mail server is the real test. */
export const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/
export const MAX_EMAIL = 254

export const newToken = () => randomBytes(16).toString('hex')

export interface Subscriber {
  id: number
  email: string
  token: string
  /** Milliseconds since the epoch. */
  at: number
}

export interface Mailing {
  id: number
  /** Set for a new-post email. */
  post: string | null
  subject: string
  body: string
  link: string | null
  at: number
  finishedAt: number | null
  /** Subscribers it has reached, and how many there were when it was written. */
  sent: number
  total: number
}

/** Whether posts show the subscribe box. */
export async function isOpen(d1: D1): Promise<boolean> {
  const { rows } = await d1.query<{ open: number }>(`SELECT open FROM newsletter WHERE id = 1`)
  return rows[0]?.open === 1
}

export async function setOpen(d1: D1, open: boolean): Promise<void> {
  await d1.query(
    `INSERT INTO newsletter (id, open) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET open = excluded.open`,
    [open ? 1 : 0],
  )
}

export async function listSubscribers(d1: D1): Promise<Subscriber[]> {
  const { rows } = await d1.query<Subscriber>(
    `SELECT id, email, token, created_at AS at FROM subscribers ORDER BY id`,
  )
  return rows
}

export async function countSubscribers(d1: D1): Promise<number> {
  const { rows } = await d1.query<{ n: number }>(`SELECT COUNT(*) AS n FROM subscribers`)
  return rows[0]?.n ?? 0
}

/**
 * The owner adding someone by hand. Returns false if they are already on the
 * list, so nobody is added twice.
 */
export async function addSubscriber(d1: D1, email: string): Promise<boolean> {
  const { changes } = await d1.query(
    `INSERT OR IGNORE INTO subscribers (email, token, created_at) VALUES (?, ?, ${NOW_MS})`,
    [email.trim(), newToken()],
  )
  return changes > 0
}

export async function removeSubscriber(d1: D1, id: number): Promise<void> {
  await d1.query(`DELETE FROM subscribers WHERE id = ?`, [id])
}

const MAILING_COLUMNS = `
  m.id, m.post, m.subject, m.body, m.link, m.created_at AS at, m.finished_at AS finishedAt,
  (SELECT COUNT(*) FROM deliveries d JOIN subscribers s ON s.id = d.subscriber_id
    WHERE d.mailing_id = m.id) AS sent,
  (SELECT COUNT(*) FROM subscribers s WHERE s.created_at <= m.created_at) AS total`

export async function getMailing(d1: D1, id: number): Promise<Mailing | null> {
  const { rows } = await d1.query<Mailing>(`SELECT ${MAILING_COLUMNS} FROM mailings m WHERE m.id = ?`, [id])
  return rows[0] ?? null
}

/** Newest first. */
export async function listMailings(d1: D1, limit = 20): Promise<Mailing[]> {
  const { rows } = await d1.query<Mailing>(
    `SELECT ${MAILING_COLUMNS} FROM mailings m ORDER BY m.id DESC LIMIT ?`,
    [limit],
  )
  return rows
}

/** Posts that have had their new-post email, so the editor stops offering one. */
export async function announcedPosts(d1: D1): Promise<string[]> {
  const { rows } = await d1.query<{ post: string }>(`SELECT post FROM mailings WHERE post IS NOT NULL`)
  return rows.map((r) => r.post)
}

/**
 * A deleted post's name is free again: a later post called the same gets its
 * own email. The old one stays in the list of what was sent.
 */
export async function forgetPost(d1: D1, post: string): Promise<void> {
  await d1.query(`UPDATE mailings SET post = NULL WHERE post = ?`, [post])
}

/**
 * Write an email down before sending it. A new-post email is made once per
 * post: asking again returns the one already made, so a second computer, or a
 * second press, resumes it instead of sending it twice.
 */
export async function createMailing(
  d1: D1,
  m: { post?: string; subject: string; body: string; link?: string },
): Promise<Mailing> {
  // Timed by the database clock, as subscriptions are by the Worker's, so a
  // computer with the wrong time cannot skip people or take in later ones.
  const { rows } = await d1.query<{ id: number }>(
    `INSERT INTO mailings (post, subject, body, link, created_at) VALUES (?, ?, ?, ?, ${NOW_MS})
       ON CONFLICT(post) DO NOTHING RETURNING id`,
    [m.post ?? null, m.subject, m.body, m.link ?? null],
  )
  const id =
    rows[0]?.id ??
    (await d1.query<{ id: number }>(`SELECT id FROM mailings WHERE post = ?`, [m.post ?? null])).rows[0]?.id
  return (await getMailing(d1, id!))!
}

/**
 * Subscribers a mailing has not reached yet. Only those who had subscribed
 * when it was written: someone joining later gets the next one.
 */
export async function pendingRecipients(d1: D1, mailingId: number, limit: number): Promise<Subscriber[]> {
  const { rows } = await d1.query<Subscriber>(
    `SELECT s.id, s.email, s.token, s.created_at AS at
       FROM subscribers s, mailings m
      WHERE m.id = ? AND s.created_at <= m.created_at
        AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.mailing_id = m.id AND d.subscriber_id = s.id)
      ORDER BY s.id LIMIT ?`,
    [mailingId, limit],
  )
  return rows
}

export async function recordDeliveries(
  d1: D1,
  mailingId: number,
  subscriberIds: number[],
  now = Date.now(),
): Promise<void> {
  if (!subscriberIds.length) return
  await d1.query(
    `INSERT OR IGNORE INTO deliveries (mailing_id, subscriber_id, sent_at)
       SELECT ?, value, ? FROM json_each(?)`,
    [mailingId, now, JSON.stringify(subscriberIds)],
  )
}

export async function finishMailing(d1: D1, mailingId: number, now = Date.now()): Promise<void> {
  await d1.query(`UPDATE mailings SET finished_at = ? WHERE id = ? AND finished_at IS NULL`, [now, mailingId])
}
