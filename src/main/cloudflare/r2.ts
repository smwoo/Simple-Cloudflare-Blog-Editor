/**
 * R2 object storage over the S3-compatible API.
 *
 * The bucket is private: the Worker reads it through a binding and serves
 * /media/*. That removes the R2 custom domain, the second hostname, the DNS
 * record and the r2.dev rate limits from setup entirely.
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import type { Secrets } from '../../shared/types.js'

/** Media is immutable: a key is never reused, so this can be a year. */
export const MEDIA_CACHE_CONTROL = 'public, max-age=31536000, immutable'

const CONTENT_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
}

export function contentTypeFor(key: string): string {
  return CONTENT_TYPES[path.extname(key).toLowerCase()] ?? 'application/octet-stream'
}

export class R2 {
  /** Set once at boot in Electron; see fetchHandler.ts for why. */
  static requestHandler: unknown

  private client: S3Client

  constructor(
    accountId: string,
    secrets: Pick<Secrets, 'r2AccessKeyId' | 'r2SecretAccessKey'>,
    private bucket: string,
  ) {
    this.client = new S3Client({
      requestHandler: R2.requestHandler as any,
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: secrets.r2AccessKeyId,
        secretAccessKey: secrets.r2SecretAccessKey,
      },
      // R2 rejects the SDK v3 default checksum behaviour.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    })
  }

  async exists(key: string): Promise<{ size: number; etag?: string } | null> {
    try {
      const r = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      )
      return { size: Number(r.ContentLength ?? 0), etag: r.ETag }
    } catch (e: any) {
      if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound') return null
      throw e
    }
  }

  /**
   * Upload a file. Refuses to overwrite a key whose content differs.
   *
   * Objects are served with a one-year immutable Cache-Control, so replacing a
   * key serves stale bytes from the edge for months with no way to force a
   * refresh. Collisions take a new index instead — see allocateKey().
   */
  async putFile(
    key: string,
    file: string,
    opts: { cacheControl?: string; onProgress?: (fraction: number) => void } = {},
  ): Promise<{ skipped: boolean }> {
    const { size } = await stat(file)
    const existing = await this.exists(key)
    if (existing) {
      if (existing.size === size) return { skipped: true }
      throw new Error(
        `refusing to overwrite ${key}: it already exists with different content. ` +
          `Media keys are immutable; allocate a new one.`,
      )
    }

    // A dropped connection mid-upload should not cost the owner a manual retry.
    for (let attempt = 1; ; attempt++) {
      const upload = new Upload({
        client: this.client,
        params: {
          Bucket: this.bucket,
          Key: key,
          Body: createReadStream(file),
          ContentType: contentTypeFor(key),
          CacheControl: opts.cacheControl ?? MEDIA_CACHE_CONTROL,
        },
        queueSize: 4,
        partSize: 8 * 1024 * 1024,
      })
      if (opts.onProgress) {
        upload.on('httpUploadProgress', (p) => {
          if (p.loaded && size) opts.onProgress!(Math.min(1, p.loaded / size))
        })
      }
      try {
        await upload.done()
        break
      } catch (e: any) {
        const status = e?.$metadata?.httpStatusCode
        if (attempt >= 3 || (status >= 400 && status < 500)) throw e
        await new Promise((r) => setTimeout(r, 1000 * attempt))
      }
    }
    return { skipped: false }
  }

  /** Small text objects: post source, config. Always overwritten, never cached. */
  async putText(key: string, body: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentTypeFor(key),
        CacheControl: 'no-cache',
      }),
    )
  }

  async getText(key: string): Promise<string | null> {
    try {
      const r = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      )
      return (await r.Body?.transformToString()) ?? null
    } catch (e: any) {
      if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NoSuchKey') return null
      throw e
    }
  }

  async list(prefix = ''): Promise<{ key: string; size: number }[]> {
    const out: { key: string; size: number }[] = []
    let token: string | undefined
    do {
      const r = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      )
      for (const o of r.Contents ?? []) {
        if (o.Key) out.push({ key: o.Key, size: Number(o.Size ?? 0) })
      }
      token = r.IsTruncated ? r.NextContinuationToken : undefined
    } while (token)
    return out
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }
}
