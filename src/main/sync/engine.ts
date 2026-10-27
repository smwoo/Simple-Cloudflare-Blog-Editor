/**
 * Keeping this computer and the shared database in step.
 *
 * Local files stay the working copy: Hugo builds from them and the editor
 * saves to them first, so writing never waits on the network. This engine
 * sends those saves on, brings other computers' changes in, and settles the
 * case where two computers changed the same post.
 *
 * Unsent work is remembered in `sync.json`, so an offline save — or a crash —
 * is sent the next time the database answers.
 */
import { readFile, writeFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { parsePost, serializePost } from '../../shared/markdown.js'
import { readPostMarkdown, writePostMarkdown, deletePost } from '../site/hugo.js'
import type { Asset } from '../../shared/types.js'
import type { Library } from '../db/library.js'
import type { BlogDb, RemoteAsset, RemoteBlog, RemotePost } from './remote.js'

export interface SyncState {
  machineId: string
  machineName: string
  /** Database time of the last complete pull. */
  lastPull: number
  /** The version of each post this computer last saw or wrote. */
  versions: Record<string, number>
  /** The version of each post this computer itself last wrote. */
  own: Record<string, number>
  /** Posts saved here but not yet sent, with the version each edit started from. */
  dirty: Record<string, number | null>
  deleted: string[]
  /** Asset keys changed or removed here but not yet sent. */
  assets: string[]
  removedAssets: string[]
  blogUpdatedAt: number
}

export interface Conflict {
  slug: string
  /** Where the other computer's version was kept. */
  copySlug: string
  machineName: string
}

export interface PullResult {
  /** Posts whose file changed here, deleted ones included. */
  posts: string[]
  assets: number
  /** Set when the blog's settings changed since the last pull. */
  blog?: RemoteBlog
}

/** Pulls overlap by this much, so a write landing mid-pull is not missed. */
const PULL_OVERLAP_MS = 5_000
export const PRESENCE_WINDOW_MS = 5 * 60_000

/** `Alices-MacBook-Pro.local` → `Alices MacBook Pro`. */
export function friendlyName(host = hostname()): string {
  return host.replace(/\.(local|lan|home)$/i, '').replace(/[-_]+/g, ' ').trim() || 'This computer'
}

export function newState(name = friendlyName()): SyncState {
  return {
    machineId: randomUUID(),
    machineName: name,
    lastPull: 0,
    versions: {},
    own: {},
    dirty: {},
    deleted: [],
    assets: [],
    removedAssets: [],
    blogUpdatedAt: 0,
  }
}

/** This computer's identity, created on first use: setup needs it before any blog exists. */
export async function ensureState(file: string): Promise<SyncState> {
  const existing = await readState(file)
  if (existing) return existing
  const state = newState()
  await writeFile(file, JSON.stringify(state, null, 2), 'utf8')
  return state
}

export async function readState(file: string): Promise<SyncState | null> {
  if (!existsSync(file)) return null
  try {
    return { ...newState(), ...JSON.parse(await readFile(file, 'utf8')) }
  } catch {
    return null
  }
}

/** A remote asset as this computer's library holds it: no original, nothing on disk yet. */
export function assetFromRemote(r: RemoteAsset, local?: Asset): Asset {
  const meta = {
    key: r.key,
    kind: r.kind,
    postSlug: r.postSlug,
    group: r.group,
    state: r.state,
    bytesOutput: r.bytesOutput,
    width: r.width,
    height: r.height,
    durationSec: r.durationSec,
    hasPoster: r.hasPoster,
    createdAt: r.createdAt,
  }
  if (local) return { ...local, ...meta, state: local.state === 'live' ? local.state : r.state }
  return { ...meta, originalPath: '', bytesOriginal: 0, originalAvailable: false }
}

export class SyncEngine {
  /** Pull and flush both rewrite versions and files, so they take turns. */
  private lock: Promise<unknown> = Promise.resolve()
  /** Saves per post since launch, to tell whether one landed while sending. */
  private edits = new Map<string, number>()
  private machineNames = new Map<string, string>()

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn)
    this.lock = run.catch(() => {})
    return run
  }

  private constructor(
    readonly db: BlogDb,
    private state: SyncState,
    private deps: { siteDir: string; library: Library; statePath: string },
  ) {}

  static async open(
    db: BlogDb,
    deps: { siteDir: string; library: Library; statePath: string },
  ): Promise<SyncEngine> {
    const state = (await readState(deps.statePath)) ?? newState()
    const engine = new SyncEngine(db, state, deps)
    await engine.persist()
    return engine
  }

  get machineId() {
    return this.state.machineId
  }
  get machineName() {
    return this.state.machineName
  }
  versionOf(slug: string): number | undefined {
    return this.state.versions[slug]
  }
  get pending(): number {
    return (
      Object.keys(this.state.dirty).length +
      this.state.deleted.length +
      this.state.assets.length +
      this.state.removedAssets.length
    )
  }

  private async persist(): Promise<void> {
    const tmp = `${this.deps.statePath}.tmp`
    await writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf8')
    await rename(tmp, this.deps.statePath)
  }

  // ------------------------------------------------------------ local changes

  /**
   * Record a post saved to disk. `baseVersion` is the version the editor
   * loaded; the first unsent edit's base is kept, so a run of offline saves
   * is still checked against what the writer actually started from.
   */
  async postSaved(slug: string, baseVersion?: number | null): Promise<void> {
    this.edits.set(slug, (this.edits.get(slug) ?? 0) + 1)
    if (!(slug in this.state.dirty)) {
      // The editor does not hear about this computer's own writes, and does
      // not need to: each was checked when sent, so the editor's text already
      // includes everything up to the last one. Only a version from
      // elsewhere, loaded or not, can be newer than both.
      const own = this.state.own[slug]
      this.state.dirty[slug] =
        baseVersion === undefined || baseVersion === null
          ? (this.state.versions[slug] ?? null)
          : Math.max(baseVersion, own ?? 0)
    }
    this.state.deleted = this.state.deleted.filter((s) => s !== slug)
    await this.persist()
  }

  async postDeleted(slug: string): Promise<void> {
    delete this.state.dirty[slug]
    if (!this.state.deleted.includes(slug)) this.state.deleted.push(slug)
    await this.persist()
  }

  async assetChanged(key: string): Promise<void> {
    this.state.removedAssets = this.state.removedAssets.filter((k) => k !== key)
    if (!this.state.assets.includes(key)) this.state.assets.push(key)
    await this.persist()
  }

  async assetRemoved(key: string): Promise<void> {
    this.state.assets = this.state.assets.filter((k) => k !== key)
    if (!this.state.removedAssets.includes(key)) this.state.removedAssets.push(key)
    await this.persist()
  }

  // ------------------------------------------------------------ send

  /** Send everything unsent. Throws when the database cannot be reached; nothing is lost. */
  flush(): Promise<Conflict[]> {
    // One at a time: two racing would both send the same base version. A call
    // made while one runs queues behind it, so a save made meanwhile goes too.
    return this.exclusive(() => this.doFlush())
  }

  private async doFlush(): Promise<Conflict[]> {
    const conflicts: Conflict[] = []
    const { db } = this
    const { siteDir, library } = this.deps

    for (const slug of Object.keys(this.state.dirty)) {
      const base = this.state.dirty[slug]
      const edits = this.edits.get(slug) ?? 0
      const markdown = await readPostMarkdown(siteDir, slug)
      if (markdown === null) {
        delete this.state.dirty[slug]
        continue
      }
      const write = toWrite(slug, markdown)
      const res = await db.putPost(write, base, this.machineId)
      if (res.ok) {
        this.state.versions[slug] = res.version
        this.state.own[slug] = res.version
      } else {
        const conflict = await this.settle(write, res.remote)
        if (conflict) conflicts.push(conflict)
      }
      // A save that landed while this one was in flight builds on what was
      // just written, so it goes next time from the new version.
      if ((this.edits.get(slug) ?? 0) === edits) delete this.state.dirty[slug]
      else if (slug in this.state.dirty) this.state.dirty[slug] = this.state.versions[slug]
      await this.persist()
    }

    for (const slug of [...this.state.deleted]) {
      await db.deletePost(slug, this.machineId)
      delete this.state.versions[slug]
      delete this.state.own[slug]
      this.state.deleted = this.state.deleted.filter((s) => s !== slug)
      await this.persist()
    }

    for (const key of [...this.state.assets]) {
      const asset = library.get(key)
      // Not live yet: the queue reports it again once it is.
      if (asset?.state === 'live') await db.putAsset(asset, this.machineId)
      this.state.assets = this.state.assets.filter((k) => k !== key)
      await this.persist()
    }

    for (const key of [...this.state.removedAssets]) {
      await db.deleteAsset(key)
      this.state.removedAssets = this.state.removedAssets.filter((k) => k !== key)
      await this.persist()
    }

    return conflicts
  }

  /**
   * Another computer saved this post since this one last saw it.
   *
   * The version here wins the slug: it is the one the writer is looking at,
   * and swapping text out under someone mid-sentence loses work. The other
   * version is kept beside it as "Title (from Alice's MacBook)". A post
   * deleted elsewhere while being edited here comes back.
   */
  private async settle(local: ReturnType<typeof toWrite>, remote: RemotePost | null): Promise<Conflict | null> {
    let conflict: Conflict | null = null
    if (remote && !remote.deletedAt && remote.markdown !== local.markdown) {
      const machineName = await this.nameOf(remote.updatedBy)
      const copySlug = await this.freeSlug(`${local.slug}-from-${slugPart(machineName)}`)
      const theirs = parsePost(copySlug, remote.markdown)
      theirs.frontMatter = {
        ...theirs.frontMatter,
        title: `${theirs.frontMatter.title || 'Untitled'} (from ${machineName})`,
        // A copy is never published by surprise.
        draft: true,
      }
      const copyMarkdown = serializePost(theirs)
      await writePostMarkdown(this.deps.siteDir, copySlug, copyMarkdown)
      this.state.versions[copySlug] = await this.db.forcePost(toWrite(copySlug, copyMarkdown), this.machineId)
      this.state.own[copySlug] = this.state.versions[copySlug]
      conflict = { slug: local.slug, copySlug, machineName }
    }
    this.state.versions[local.slug] = await this.db.forcePost(local, this.machineId)
    this.state.own[local.slug] = this.state.versions[local.slug]
    return conflict
  }

  private async freeSlug(base: string): Promise<string> {
    for (let n = 1; ; n++) {
      const slug = n === 1 ? base : `${base}-${n}`
      const taken =
        (await readPostMarkdown(this.deps.siteDir, slug)) !== null || (await this.db.getPost(slug)) !== null
      if (!taken) return slug
    }
  }

  private async nameOf(machineId: string | null): Promise<string> {
    if (!machineId) return 'another computer'
    if (!this.machineNames.has(machineId)) {
      for (const m of await this.db.machines()) this.machineNames.set(m.id, m.name)
    }
    return this.machineNames.get(machineId) ?? 'another computer'
  }

  // ------------------------------------------------------------ receive

  /** Bring in what other computers changed. Throws when the database cannot be reached. */
  pull(): Promise<PullResult> {
    return this.exclusive(() => this.doPull())
  }

  private async doPull(): Promise<PullResult> {
    const { db } = this
    const { siteDir, library } = this.deps
    const now = await db.now()
    const since = Math.max(0, this.state.lastPull - PULL_OVERLAP_MS)
    const result: PullResult = { posts: [], assets: 0 }

    for (const remote of await db.postsSince(since)) {
      const seen = this.state.versions[remote.slug] ?? 0
      if (remote.version <= seen) continue
      // Unsent edits here: the next flush sees the newer version and settles it.
      if (remote.slug in this.state.dirty) continue
      if (remote.deletedAt) {
        await deletePost(siteDir, remote.slug)
        delete this.state.versions[remote.slug]
        delete this.state.own[remote.slug]
      } else {
        await writePostMarkdown(siteDir, remote.slug, remote.markdown)
        this.state.versions[remote.slug] = remote.version
      }
      result.posts.push(remote.slug)
    }

    for (const remote of await db.assetsSince(since)) {
      if (this.state.assets.includes(remote.key) || this.state.removedAssets.includes(remote.key)) continue
      const local = library.get(remote.key)
      if (remote.deletedAt) {
        if (!local) continue
        // The original, if this computer has one, stays on disk.
        await library.remove(remote.key)
      } else {
        await library.put(assetFromRemote(remote, local))
      }
      result.assets++
    }

    const blog = await db.readBlog()
    if (blog && blog.updatedAt > this.state.blogUpdatedAt) {
      result.blog = blog
      this.state.blogUpdatedAt = blog.updatedAt
    }

    this.state.lastPull = now
    await this.persist()
    return result
  }

  /** Mark everything currently in the database as seen: after connecting or migrating. */
  async adopt(versions: Record<string, number>, blogUpdatedAt: number, at: number): Promise<void> {
    this.state.versions = { ...versions }
    this.state.own = {}
    this.state.blogUpdatedAt = blogUpdatedAt
    this.state.lastPull = at
    await this.persist()
  }

  // ------------------------------------------------------------ presence

  /** Say this computer is here, and return the others active in the last few minutes. */
  async heartbeat(info: { platform: string; appVersion: string }): Promise<string[]> {
    await this.db.touchMachine({
      id: this.machineId,
      name: this.machineName,
      platform: info.platform,
      appVersion: info.appVersion,
    })
    const now = await this.db.now()
    const machines = await this.db.machines()
    for (const m of machines) this.machineNames.set(m.id, m.name)
    return machines
      .filter((m) => m.id !== this.machineId && now - m.lastSeen < PRESENCE_WINDOW_MS)
      .map((m) => m.name)
  }
}

function toWrite(slug: string, markdown: string) {
  const { frontMatter } = parsePost(slug, markdown)
  return { slug, title: frontMatter.title, date: frontMatter.date, draft: frontMatter.draft, markdown }
}

function slugPart(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'other'
  )
}
