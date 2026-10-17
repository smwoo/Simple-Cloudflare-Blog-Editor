/** Types shared between the Electron main process and the renderer. */

// ---------------------------------------------------------------- documents

/**
 * The document is ProseMirror JSON, exactly as TipTap's `editor.getJSON()`
 * returns it, so the editor output feeds the serializer with no conversion.
 */
export interface PMMark {
  type: 'bold' | 'italic' | 'strike' | 'code' | 'link'
  attrs?: Record<string, unknown>
}

export interface PMNode {
  type: string
  attrs?: Record<string, any>
  content?: PMNode[]
  marks?: PMMark[]
  text?: string
}

/**
 * Front matter. Emitted from a template rather than a YAML serializer, so the
 * shape is fixed and predictable.
 *
 * `cover.relative` is always false and is never shown in the UI — it is the
 * field that silently breaks cover images when wrong.
 */
export interface FrontMatter {
  title: string
  /** ISO date, `YYYY-MM-DD`. */
  date: string
  draft: boolean
  description?: string
  /** Asset key of the cover image, or undefined. */
  cover?: string
}

export interface Post {
  /** Filename stem, e.g. `nov-2026`. Also the media key prefix. */
  slug: string
  frontMatter: FrontMatter
  doc: PMNode
}

// ---------------------------------------------------------------- media

export type AssetKind = 'image' | 'video'

/**
 * `local`     – copied to the originals archive, not yet converted
 * `converting`– sharp/ffmpeg running
 * `uploading` – converted, upload in flight
 * `live`      – in the bucket
 * `failed`    – conversion or upload failed; `error` is set
 */
export type AssetState = 'local' | 'converting' | 'uploading' | 'live' | 'failed'

export interface Asset {
  /**
   * The R2 object key AND the stable identity used in documents:
   * `<post-slug>/<group>/<group>-<n>.avif`. Served at `/media/<key>`.
   *
   * Assigned when the file is dropped, never when the upload completes, so the
   * document is stable and serializable from the first second.
   */
  key: string
  kind: AssetKind
  postSlug: string
  group: string
  state: AssetState
  /** Absolute path to the preserved original. */
  originalPath: string
  /** Absolute path to the converted web output, once it exists. */
  outputPath?: string
  /** Absolute path to a poster frame (video) or thumbnail (image). */
  posterPath?: string
  /** Low-res H.264 proxy for in-app playback; Windows Chromium may not decode HEVC. */
  proxyPath?: string
  bytesOriginal: number
  bytesOutput?: number
  width?: number
  height?: number
  durationSec?: number
  error?: string
  createdAt: number
}

/** Site path for an asset. Root-relative so a domain change rewrites no content. */
export function mediaPath(key: string): string {
  return `/media/${key}`
}

/** Inverse of `mediaPath`. Returns null if the path is not ours. */
export function keyFromMediaPath(path: string): string | null {
  const m = /^\/media\/(.+)$/.exec(path.trim())
  return m ? m[1] : null
}

// ---------------------------------------------------------------- jobs

export interface JobProgress {
  key: string
  state: AssetState
  /** 0–1 where known, else undefined (image conversion is effectively atomic). */
  fraction?: number
  error?: string
}

// ---------------------------------------------------------------- config

export interface BlogConfig {
  /** Cloudflare account id, discovered from the token. */
  accountId: string
  /** Worker + bucket name, e.g. `alice-blog`. */
  name: string
  bucket: string
  /** Live site origin, e.g. `https://alice-blog.alice.workers.dev`. */
  siteUrl: string
  /** Set once a custom domain is attached. */
  customDomain?: string
  title: string
  author: string
  /**
   * Password visitors type to see the blog. Kept in the clear because the
   * owner hands it out, and because it guards nothing: see `siteOverlay`.
   */
  sitePassword?: string
}

/** Never serialised to disk in the clear — held in Electron safeStorage. */
export interface Secrets {
  cloudflareToken: string
  r2AccessKeyId: string
  r2SecretAccessKey: string
}

export interface TokenCheck {
  ok: boolean
  accountId?: string
  accountName?: string
  /** Permissions that are present. */
  granted: string[]
  /** Permissions required but absent — named precisely so a helper fixes it in one pass. */
  missing: string[]
  /** Absent but only needed later (custom domain). Never blocks setup. */
  optionalMissing?: string[]
  /** True when the credential looks like a Global API Key rather than a scoped token. */
  looksLikeGlobalKey?: boolean
  error?: string
}
