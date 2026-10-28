/**
 * Comments: what visitors write to the blog, with newsletter subscriptions
 * (see newsletter.ts).
 *
 * They live in their own database, not the shared one. The Worker has to bind
 * this one to accept comments, and the shared one holds the storage keys, so
 * keeping them apart means the public site can reach visitors' data and nothing else.
 *
 * Threads are one level deep: a comment, then its replies in order. A reply to
 * a reply joins the same thread, so `parent_id` always names a top comment.
 */
import type { CloudflareClient } from './api.js'
import { RestD1, ensureDatabase, listDatabases, type D1 } from './d1.js'
import { NEWSLETTER_SCHEMA_SQL } from './newsletter.js'

export const COMMENTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post TEXT NOT NULL,
  parent_id INTEGER,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  ip_hash TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_post ON comments(post, id);
CREATE INDEX IF NOT EXISTS comments_ip ON comments(ip_hash, created_at);
`

/** `alice-blog` → `alice-blog-comments`. */
export const commentsDatabaseName = (blogName: string) => `${blogName}-comments`

/** Create the database if needed and bring its schema up to date. Returns its id. */
export async function ensureCommentsDatabase(
  cf: CloudflareClient,
  accountId: string,
  blogName: string,
): Promise<string> {
  const database = await ensureDatabase(cf, accountId, commentsDatabaseName(blogName))
  await new RestD1(cf, accountId, database.uuid).exec(COMMENTS_SCHEMA_SQL + NEWSLETTER_SCHEMA_SQL)
  return database.uuid
}

/** The database if a deploy has made it yet, without creating it. */
export async function findCommentsDatabase(
  cf: CloudflareClient,
  accountId: string,
  blogName: string,
): Promise<string | null> {
  const name = commentsDatabaseName(blogName)
  return (await listDatabases(cf, accountId)).find((d) => d.name === name)?.uuid ?? null
}

export interface Comment {
  id: number
  /** The top comment this replies to; null for a top comment. */
  parent: number | null
  name: string
  body: string
  /** Milliseconds since the epoch. */
  at: number
}

export async function listComments(d1: D1, post: string): Promise<Comment[]> {
  const { rows } = await d1.query<Comment>(
    `SELECT id, parent_id AS parent, name, body, created_at AS at
       FROM comments WHERE post = ? ORDER BY id`,
    [post],
  )
  return rows
}

/** Deletes a comment and, for a top comment, its replies. Returns how many went. */
export async function deleteComment(d1: D1, id: number): Promise<number> {
  const { changes } = await d1.query(`DELETE FROM comments WHERE id = ? OR parent_id = ?`, [id, id])
  return changes
}

export async function deletePostComments(d1: D1, post: string): Promise<void> {
  await d1.query(`DELETE FROM comments WHERE post = ?`, [post])
}
