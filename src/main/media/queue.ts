/**
 * The conversion + upload queue.
 *
 * Keys are allocated by the caller before anything is enqueued, so the editor
 * can insert the node immediately and the document is stable from the first
 * second. This queue only moves an asset from `converting` to `live`.
 */
import { cpus } from 'node:os'
import { existsSync } from 'node:fs'
import type { Asset, JobProgress } from '../../shared/types.js'
import type { Library } from '../db/library.js'
import type { R2 } from '../cloudflare/r2.js'
import { ingest, type ConvertSettings, type IngestPaths } from './pipeline.js'

export interface QueuedFile {
  srcFile: string
  key: string
  postSlug: string
  group: string
}

type Listener = (p: JobProgress) => void

export class MediaQueue {
  private queue: QueuedFile[] = []
  private active = 0
  private listeners = new Set<Listener>()
  private concurrency: number
  private idleResolvers: (() => void)[] = []

  constructor(
    private library: Library,
    private paths: IngestPaths,
    private settings: ConvertSettings,
    private r2: () => R2 | null,
    concurrency?: number,
  ) {
    // Video encoding is CPU-bound; leave the machine usable while it runs.
    this.concurrency = concurrency ?? Math.max(1, Math.floor(cpus().length / 2))
  }

  onProgress(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(p: JobProgress) {
    for (const fn of this.listeners) fn(p)
  }

  get pendingCount(): number {
    return this.queue.length + this.active
  }

  add(files: QueuedFile[]): void {
    this.queue.push(...files)
    this.pump()
  }

  /** Resolves when nothing is queued or in flight. Publishing waits on this. */
  idle(): Promise<void> {
    if (this.pendingCount === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleResolvers.push(resolve))
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!
      this.active++
      this.process(job)
        .catch(() => {
          /* already recorded on the asset */
        })
        .finally(() => {
          this.active--
          if (this.pendingCount === 0) {
            const waiters = this.idleResolvers.splice(0)
            for (const r of waiters) r()
          }
          this.pump()
        })
    }
  }

  private async process(job: QueuedFile): Promise<void> {
    const { key } = job
    try {
      this.emit({ key, state: 'converting', fraction: 0 })

      const asset: Asset = await ingest(
        job.srcFile,
        key,
        job.postSlug,
        job.group,
        this.paths,
        this.settings,
        (fraction) => this.emit({ key, state: 'converting', fraction }),
      )
      await this.library.put(asset)
      this.emit({ key, state: 'uploading', fraction: 0 })

      const r2 = this.r2()
      if (!r2) {
        // Not configured yet (first run, or offline setup). The asset stays
        // local and is retried on the next publish rather than being lost.
        await this.library.setState(key, 'uploading')
        this.emit({ key, state: 'uploading' })
        return
      }

      await r2.putFile(key, asset.outputPath!, {
        onProgress: (fraction) => this.emit({ key, state: 'uploading', fraction }),
      })
      await this.library.setState(key, 'live')
      this.emit({ key, state: 'live', fraction: 1 })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const existing = this.library.get(key)
      if (existing) await this.library.setState(key, 'failed', message)
      this.emit({ key, state: 'failed', error: message })
    }
  }

  /** Re-upload anything converted but never sent — e.g. queued while offline. */
  async flushUploads(): Promise<{ uploaded: number; failed: number }> {
    const r2 = this.r2()
    if (!r2) return { uploaded: 0, failed: 0 }
    let uploaded = 0
    let failed = 0
    for (const asset of this.library.all()) {
      // Failed uploads with a finished conversion are retried too; failed
      // conversions have no output and need retry() instead.
      const retryable = asset.state === 'uploading' || asset.state === 'failed'
      if (!retryable || !asset.outputPath || !existsSync(asset.outputPath)) continue
      try {
        await r2.putFile(asset.key, asset.outputPath)
        await this.library.setState(asset.key, 'live')
        this.emit({ key: asset.key, state: 'live', fraction: 1 })
        uploaded++
      } catch (e) {
        failed++
        await this.library.setState(
          asset.key,
          'failed',
          e instanceof Error ? e.message : String(e),
        )
      }
    }
    return { uploaded, failed }
  }

  async retry(key: string): Promise<void> {
    const asset = this.library.get(key)
    if (!asset) return
    // Conversion already done (the upload failed): re-send, don't re-encode.
    if (asset.outputPath && existsSync(asset.outputPath)) {
      const r2 = this.r2()
      if (!r2) return
      try {
        await this.library.setState(key, 'uploading')
        this.emit({ key, state: 'uploading', fraction: 0 })
        await r2.putFile(key, asset.outputPath, {
          onProgress: (fraction) => this.emit({ key, state: 'uploading', fraction }),
        })
        await this.library.setState(key, 'live')
        this.emit({ key, state: 'live', fraction: 1 })
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        await this.library.setState(key, 'failed', message)
        this.emit({ key, state: 'failed', error: message })
      }
      return
    }
    this.add([
      { srcFile: asset.originalPath, key, postSlug: asset.postSlug, group: asset.group },
    ])
  }
}
