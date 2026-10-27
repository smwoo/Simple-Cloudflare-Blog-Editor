/**
 * Typed access to the shared database. Every write here is a single statement:
 * the D1 HTTP API has no transactions, so each one must be safe on its own.
 */
import type { D1, SqlValue } from '../cloudflare/d1.js'
import { NOW_MS, SCHEMA_SQL, SCHEMA_VERSION } from './schema.js'
import type { Asset, AssetKind, AssetState } from '../../shared/types.js'

export interface RemoteBlog {
  schemaVersion: number
  name: string
  title: string
  author: string
  siteUrl: string
  customDomain?: string
  sitePassword?: string
  bucket: string
  r2AccessKeyId: string
  r2Secret: string
  updatedAt: number
}

export interface RemotePost {
  slug: string
  title: string
  date: string
  draft: boolean
  markdown: string
  version: number
  updatedAt: number
  updatedBy: string | null
  deletedAt: number | null
}

/** What a computer sends for a post: the file as written, plus the columns lists need. */
export interface PostWrite {
  slug: string
  title: string
  date: string
  draft: boolean
  markdown: string
}

export interface RemoteAsset {
  key: string
  kind: AssetKind
  postSlug: string
  group: string
  state: AssetState
  bytesOutput?: number
  width?: number
  height?: number
  durationSec?: number
  hasPoster: boolean
  createdAt: number
  originMachine: string | null
  updatedAt: number
  deletedAt: number | null
}

export interface Machine {
  id: string
  name: string
  platform: string | null
  appVersion: string | null
  lastSeen: number
}

export type PutResult = { ok: true; version: number } | { ok: false; remote: RemotePost | null }

/** A snapshot is kept at most this often per post, so autosave does not flood history. */
const SNAPSHOT_EVERY_MS = 10 * 60_000
const KEEP_VERSIONS = 20

const num = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : Number(v))

function toPost(r: any): RemotePost {
  return {
    slug: r.slug,
    title: r.title,
    date: r.date,
    draft: !!r.draft,
    markdown: r.markdown,
    version: Number(r.version),
    updatedAt: Number(r.updated_at),
    updatedBy: r.updated_by ?? null,
    deletedAt: r.deleted_at === null || r.deleted_at === undefined ? null : Number(r.deleted_at),
  }
}

function toAsset(r: any): RemoteAsset {
  return {
    key: r.key,
    kind: r.kind,
    postSlug: r.post_slug,
    group: r.grp,
    state: r.state,
    bytesOutput: num(r.bytes_output),
    width: num(r.width),
    height: num(r.height),
    durationSec: num(r.duration_sec),
    hasPoster: !!r.has_poster,
    createdAt: Number(r.created_at),
    originMachine: r.origin_machine ?? null,
    updatedAt: Number(r.updated_at),
    deletedAt: r.deleted_at === null || r.deleted_at === undefined ? null : Number(r.deleted_at),
  }
}

export class BlogDb {
  constructor(readonly d1: D1) {}

  async applySchema(): Promise<void> {
    await this.d1.exec(SCHEMA_SQL)
  }

  /** The database clock, so every computer compares against the same time. */
  async now(): Promise<number> {
    const { rows } = await this.d1.query<{ now: number }>(`SELECT ${NOW_MS} AS now`)
    return Number(rows[0]?.now ?? 0)
  }

  // ------------------------------------------------------------ blog

  /** Null when the database is not a blog: no table, or no row. */
  async readBlog(): Promise<RemoteBlog | null> {
    let rows: any[]
    try {
      rows = (await this.d1.query('SELECT * FROM blog WHERE id = 1')).rows
    } catch {
      return null
    }
    const r = rows[0]
    if (!r) return null
    return {
      schemaVersion: Number(r.schema_version),
      name: r.name,
      title: r.title,
      author: r.author,
      siteUrl: r.site_url,
      customDomain: r.custom_domain ?? undefined,
      sitePassword: r.site_password ?? undefined,
      bucket: r.bucket,
      r2AccessKeyId: r.r2_access_key_id,
      r2Secret: r.r2_secret,
      updatedAt: Number(r.updated_at),
    }
  }

  async writeBlog(b: Omit<RemoteBlog, 'schemaVersion' | 'updatedAt'>): Promise<void> {
    await this.d1.query(
      `INSERT INTO blog (id, schema_version, name, title, author, site_url, custom_domain,
         site_password, bucket, r2_access_key_id, r2_secret, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW_MS})
       ON CONFLICT(id) DO UPDATE SET
         schema_version = excluded.schema_version, name = excluded.name, title = excluded.title,
         author = excluded.author, site_url = excluded.site_url,
         custom_domain = excluded.custom_domain, site_password = excluded.site_password,
         bucket = excluded.bucket, r2_access_key_id = excluded.r2_access_key_id,
         r2_secret = excluded.r2_secret, updated_at = excluded.updated_at`,
      [
        SCHEMA_VERSION,
        b.name,
        b.title,
        b.author,
        b.siteUrl,
        b.customDomain ?? null,
        b.sitePassword ?? null,
        b.bucket,
        b.r2AccessKeyId,
        b.r2Secret,
      ],
    )
  }

  /** Site-wide settings a computer can change after setup. */
  async updateBlog(
    patch: Partial<Pick<RemoteBlog, 'customDomain' | 'sitePassword' | 'r2AccessKeyId' | 'r2Secret'>>,
  ): Promise<void> {
    const cols: Record<string, string> = {
      customDomain: 'custom_domain',
      sitePassword: 'site_password',
      r2AccessKeyId: 'r2_access_key_id',
      r2Secret: 'r2_secret',
    }
    const sets: string[] = []
    const params: SqlValue[] = []
    for (const [k, col] of Object.entries(cols)) {
      if (!(k in patch)) continue
      sets.push(`${col} = ?`)
      params.push((patch as Record<string, string | undefined>)[k] ?? null)
    }
    if (!sets.length) return
    await this.d1.query(`UPDATE blog SET ${sets.join(', ')}, updated_at = ${NOW_MS} WHERE id = 1`, params)
  }

  // ------------------------------------------------------------ posts

  async getPost(slug: string): Promise<RemotePost | null> {
    const { rows } = await this.d1.query('SELECT * FROM posts WHERE slug = ?', [slug])
    return rows[0] ? toPost(rows[0]) : null
  }

  /** Every post changed at or after `since`, deleted ones included. */
  async postsSince(since: number): Promise<RemotePost[]> {
    const { rows } = await this.d1.query('SELECT * FROM posts WHERE updated_at >= ?', [since])
    return rows.map(toPost)
  }

  /**
   * Save a post only if nobody else has since `baseVersion` (null: this
   * computer has never seen it in the database). A deleted post can be
   * written over: writing it again brings it back.
   */
  async putPost(p: PostWrite, baseVersion: number | null, machineId: string): Promise<PutResult> {
    const values = [p.slug, p.title, p.date, p.draft ? 1 : 0, p.markdown, machineId]
    const res =
      baseVersion === null
        ? await this.d1.query(
            `INSERT INTO posts (slug, title, date, draft, markdown, version, updated_at, updated_by)
             VALUES (?, ?, ?, ?, ?, 1, ${NOW_MS}, ?)
             ON CONFLICT(slug) DO UPDATE SET
               title = excluded.title, date = excluded.date, draft = excluded.draft,
               markdown = excluded.markdown, version = posts.version + 1,
               updated_at = excluded.updated_at, updated_by = excluded.updated_by, deleted_at = NULL
             WHERE posts.deleted_at IS NOT NULL`,
            values,
          )
        : await this.d1.query(
            `UPDATE posts SET title = ?, date = ?, draft = ?, markdown = ?, updated_by = ?,
               version = version + 1, updated_at = ${NOW_MS}, deleted_at = NULL
             WHERE slug = ? AND version = ?`,
            [p.title, p.date, p.draft ? 1 : 0, p.markdown, machineId, p.slug, baseVersion],
          )
    const remote = await this.getPost(p.slug)
    if (res.changes === 0 || !remote) return { ok: false, remote }
    await this.snapshot(remote, machineId)
    return { ok: true, version: remote.version }
  }

  /** Write regardless of version. For migration and for settling a conflict. */
  async forcePost(p: PostWrite, machineId: string): Promise<number> {
    await this.d1.query(
      `INSERT INTO posts (slug, title, date, draft, markdown, version, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, 1, ${NOW_MS}, ?)
       ON CONFLICT(slug) DO UPDATE SET
         title = excluded.title, date = excluded.date, draft = excluded.draft,
         markdown = excluded.markdown, version = posts.version + 1,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by, deleted_at = NULL`,
      [p.slug, p.title, p.date, p.draft ? 1 : 0, p.markdown, machineId],
    )
    const remote = (await this.getPost(p.slug))!
    await this.snapshot(remote, machineId)
    return remote.version
  }

  /** Mark deleted rather than remove, so the post never comes back from another computer. */
  async deletePost(slug: string, machineId: string): Promise<void> {
    await this.d1.query(
      `UPDATE posts SET deleted_at = ${NOW_MS}, updated_at = ${NOW_MS},
         version = version + 1, updated_by = ? WHERE slug = ? AND deleted_at IS NULL`,
      [machineId, slug],
    )
  }

  private async snapshot(p: RemotePost, machineId: string): Promise<void> {
    await this.d1.query(
      `INSERT OR IGNORE INTO post_versions (slug, version, markdown, saved_at, machine_id)
       SELECT ?, ?, ?, ${NOW_MS}, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM post_versions WHERE slug = ? AND saved_at > ${NOW_MS} - ?)`,
      [p.slug, p.version, p.markdown, machineId, p.slug, SNAPSHOT_EVERY_MS],
    )
    await this.d1.query(
      `DELETE FROM post_versions WHERE slug = ? AND version NOT IN (
         SELECT version FROM post_versions WHERE slug = ? ORDER BY version DESC LIMIT ?)`,
      [p.slug, p.slug, KEEP_VERSIONS],
    )
  }

  async versions(slug: string): Promise<{ version: number; savedAt: number; markdown: string }[]> {
    const { rows } = await this.d1.query<any>(
      'SELECT version, saved_at, markdown FROM post_versions WHERE slug = ? ORDER BY version DESC',
      [slug],
    )
    return rows.map((r) => ({ version: Number(r.version), savedAt: Number(r.saved_at), markdown: r.markdown }))
  }

  // ------------------------------------------------------------ assets

  async putAsset(a: Asset, machineId: string): Promise<void> {
    await this.d1.query(
      `INSERT INTO assets (key, kind, post_slug, grp, state, bytes_output, width, height,
         duration_sec, has_poster, created_at, origin_machine, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW_MS}, NULL)
       ON CONFLICT(key) DO UPDATE SET
         kind = excluded.kind, post_slug = excluded.post_slug, grp = excluded.grp,
         state = excluded.state, bytes_output = excluded.bytes_output, width = excluded.width,
         height = excluded.height, duration_sec = excluded.duration_sec,
         has_poster = excluded.has_poster, updated_at = excluded.updated_at, deleted_at = NULL`,
      [
        a.key,
        a.kind,
        a.postSlug,
        a.group,
        a.state,
        a.bytesOutput ?? null,
        a.width ?? null,
        a.height ?? null,
        a.durationSec ?? null,
        a.hasPoster ? 1 : 0,
        a.createdAt,
        machineId,
      ],
    )
  }

  async deleteAsset(key: string): Promise<void> {
    await this.d1.query(
      `UPDATE assets SET deleted_at = ${NOW_MS}, updated_at = ${NOW_MS}
       WHERE key = ? AND deleted_at IS NULL`,
      [key],
    )
  }

  async assetsSince(since: number): Promise<RemoteAsset[]> {
    const { rows } = await this.d1.query('SELECT * FROM assets WHERE updated_at >= ?', [since])
    return rows.map(toAsset)
  }

  async counts(): Promise<{ posts: number; assets: number }> {
    const p = await this.d1.query<{ n: number }>('SELECT COUNT(*) AS n FROM posts WHERE deleted_at IS NULL')
    const a = await this.d1.query<{ n: number }>('SELECT COUNT(*) AS n FROM assets WHERE deleted_at IS NULL')
    return { posts: Number(p.rows[0]?.n ?? 0), assets: Number(a.rows[0]?.n ?? 0) }
  }

  // ------------------------------------------------------------ machines

  async touchMachine(m: Omit<Machine, 'lastSeen'>): Promise<void> {
    await this.d1.query(
      `INSERT INTO machines (id, name, platform, app_version, last_seen)
       VALUES (?, ?, ?, ?, ${NOW_MS})
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, platform = excluded.platform,
         app_version = excluded.app_version, last_seen = excluded.last_seen`,
      [m.id, m.name, m.platform, m.appVersion],
    )
  }

  async machines(): Promise<Machine[]> {
    const { rows } = await this.d1.query<any>('SELECT * FROM machines ORDER BY last_seen DESC')
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      platform: r.platform ?? null,
      appVersion: r.app_version ?? null,
      lastSeen: Number(r.last_seen),
    }))
  }
}
