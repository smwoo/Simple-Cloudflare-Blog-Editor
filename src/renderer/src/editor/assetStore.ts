/**
 * Live asset state, shared by the library pane and the editor's node views.
 *
 * Deliberately an external store rather than React context: TipTap renders node
 * views through portals that do not inherit context, and `useSyncExternalStore`
 * works from anywhere.
 *
 * State lives here, never in the document. A node holds only an asset key, so
 * the document is stable while uploads progress underneath it.
 */
import { useSyncExternalStore } from 'react'
import type { Asset, JobProgress } from '../../../shared/types.js'

type Listener = () => void

class AssetStore {
  private assets = new Map<string, Asset>()
  private progress = new Map<string, number>()
  private listeners = new Set<Listener>()
  private snapshotCache: Asset[] = []
  private dirty = true

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private changed() {
    this.dirty = true
    for (const fn of this.listeners) fn()
  }

  /** Stable snapshot: useSyncExternalStore requires referential equality. */
  snapshot = (): Asset[] => {
    if (this.dirty) {
      this.snapshotCache = [...this.assets.values()].sort((a, b) => a.createdAt - b.createdAt)
      this.dirty = false
    }
    return this.snapshotCache
  }

  replaceAll(assets: Asset[]) {
    this.assets = new Map(assets.map((a) => [a.key, a]))
    this.changed()
  }

  get(key: string): Asset | undefined {
    return this.assets.get(key)
  }

  fraction(key: string): number | undefined {
    return this.progress.get(key)
  }

  applyProgress(p: JobProgress) {
    const existing = this.assets.get(p.key)
    if (existing) {
      this.assets.set(p.key, { ...existing, state: p.state, error: p.error })
    }
    if (p.fraction !== undefined) this.progress.set(p.key, p.fraction)
    if (p.state === 'live') this.progress.delete(p.key)
    this.changed()
  }

  /** Keys referenced by the open document, so the grid can mark what is placed. */
  private placed = new Set<string>()
  setPlaced(keys: string[]) {
    this.placed = new Set(keys)
    this.changed()
  }
  isPlaced(key: string): boolean {
    return this.placed.has(key)
  }
}

export const assetStore = new AssetStore()

export function useAssets(): Asset[] {
  return useSyncExternalStore(assetStore.subscribe, assetStore.snapshot)
}

export function useAsset(key: string): { asset?: Asset; fraction?: number } {
  const assets = useAssets()
  const asset = assets.find((a) => a.key === key)
  return { asset, fraction: assetStore.fraction(key) }
}

// ---------------------------------------------------------------- urls

const path = (key: string) => key.split('/').map(encodeURIComponent).join('/')

/**
 * The converted web file: from disk when this computer made it, which works
 * before any upload, and from the blog when another computer did.
 */
export function outputUrl(key: string): string {
  return `blogmedia://output/${path(key)}`
}

/** Thumbnail (images) or poster frame (video). */
export function posterUrl(key: string): string {
  return `blogmedia://poster/${path(key)}`
}

/**
 * Playback source for the editor.
 *
 * Videos use the H.264 proxy, not the HEVC output: Chromium decodes HEVC on
 * macOS but on Windows leans on a platform decoder many machines lack, so
 * without this the owner drags in a video, finds it will not play, and
 * concludes it is broken — while it plays perfectly on the published site.
 */
export function playbackUrl(key: string): string {
  return `blogmedia://play/${path(key)}`
}
