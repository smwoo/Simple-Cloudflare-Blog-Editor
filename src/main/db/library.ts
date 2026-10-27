/**
 * The asset library.
 *
 * Backed by a JSON file rather than SQLite. At this scale — a personal blog
 * accumulating a few thousand assets over years — a JSON document is entirely
 * adequate, and it removes a native dependency that would otherwise need an
 * electron-rebuild for every platform and architecture. The interface below is
 * deliberately narrow so swapping in SQLite later is a contained change.
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Asset, AssetState } from '../../shared/types.js'

interface LibraryFile {
  /** 2: paths inside the data folder are stored relative to it. */
  version: 1 | 2
  assets: Record<string, Asset>
}

const PATH_FIELDS = ['originalPath', 'outputPath', 'posterPath', 'proxyPath'] as const

/**
 * Paths are kept absolute in memory and relative on disk, so the file means the
 * same thing wherever the data folder lives. Paths outside it — a file still
 * waiting to be copied in from the Desktop — stay absolute.
 */
function mapPaths(asset: Asset, fn: (p: string) => string): Asset {
  const out = { ...asset }
  for (const f of PATH_FIELDS) if (out[f]) out[f] = fn(out[f]!)
  return out
}

export function toRelative(base: string, p: string): string {
  const rel = path.relative(base, p)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return p
  return rel.split(path.sep).join('/')
}

export function toAbsolute(base: string, p: string): string {
  if (!p || path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p)) return p
  return path.join(base, ...p.split('/'))
}

export class Library {
  private data: LibraryFile = { version: 2, assets: {} }
  private writing: Promise<void> = Promise.resolve()

  private constructor(private file: string) {}

  private get base() {
    return path.dirname(this.file)
  }

  static async open(file: string): Promise<Library> {
    const lib = new Library(file)
    await mkdir(path.dirname(file), { recursive: true })
    if (existsSync(file)) {
      try {
        const raw: LibraryFile = JSON.parse(await readFile(file, 'utf8'))
        const assets: Record<string, Asset> = {}
        for (const [k, a] of Object.entries(raw.assets ?? {})) {
          assets[k] = mapPaths(a, (p) => toAbsolute(lib.base, p))
        }
        lib.data = { version: 2, assets }
      } catch {
        // A corrupt library is rebuildable from disk and the bucket, so losing
        // it is survivable — refusing to start is not.
        lib.data = { version: 2, assets: {} }
      }
    }
    return lib
  }

  /** Writes are serialised and atomic: a crash mid-save must not truncate it. */
  private save(): Promise<void> {
    this.writing = this.writing.then(async () => {
      const tmp = `${this.file}.tmp`
      const assets: Record<string, Asset> = {}
      for (const [k, a] of Object.entries(this.data.assets)) {
        assets[k] = mapPaths(a, (p) => toRelative(this.base, p))
      }
      await writeFile(tmp, JSON.stringify({ version: 2, assets }, null, 2), 'utf8')
      await rename(tmp, this.file)
    })
    return this.writing
  }

  get(key: string): Asset | undefined {
    return this.data.assets[key]
  }

  all(): Asset[] {
    return Object.values(this.data.assets).sort((a, b) => a.createdAt - b.createdAt)
  }

  forPost(slug: string): Asset[] {
    return this.all().filter((a) => a.postSlug === slug)
  }

  /** Every key in use, so allocateKey() never collides. */
  takenKeys(): Set<string> {
    return new Set(Object.keys(this.data.assets))
  }

  async put(asset: Asset): Promise<void> {
    this.data.assets[asset.key] = asset
    await this.save()
  }

  async update(key: string, patch: Partial<Asset>): Promise<Asset | undefined> {
    const current = this.data.assets[key]
    if (!current) return undefined
    const next = { ...current, ...patch }
    this.data.assets[key] = next
    await this.save()
    return next
  }

  async setState(key: string, state: AssetState, error?: string): Promise<void> {
    await this.update(key, { state, error })
  }

  async remove(key: string): Promise<void> {
    delete this.data.assets[key]
    await this.save()
  }

  /**
   * Assets uploaded but referenced by no post.
   *
   * Someone drags in 40 photos, places 25, and forgets 15. Without surfacing
   * this, those sit in their storage forever — paid for and invisible.
   */
  unplaced(referenced: ReadonlySet<string>): Asset[] {
    return this.all().filter((a) => !referenced.has(a.key))
  }

  /** Assets a post references that the library has never heard of. */
  missing(referenced: ReadonlySet<string>): string[] {
    return [...referenced].filter((k) => !this.data.assets[k])
  }

  /** Anything not yet live blocks publishing. */
  pending(keys: ReadonlySet<string>): Asset[] {
    return this.all().filter((a) => keys.has(a.key) && a.state !== 'live')
  }

  stats(): {
    count: number
    bytesOriginal: number
    bytesOutput: number
    /** Added on another computer: shown from the blog, no original here. */
    remote: number
  } {
    let bytesOriginal = 0
    let bytesOutput = 0
    let remote = 0
    const assets = this.all()
    for (const a of assets) {
      bytesOriginal += a.bytesOriginal
      bytesOutput += a.bytesOutput ?? 0
      if (a.originalAvailable === false) remote++
    }
    return { count: assets.length, bytesOriginal, bytesOutput, remote }
  }

  /** Drop everything and load these: connecting a new computer to a blog. */
  async replaceAll(assets: Asset[]): Promise<void> {
    this.data.assets = Object.fromEntries(assets.map((a) => [a.key, a]))
    await this.save()
  }
}
