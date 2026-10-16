/**
 * An AWS SDK request handler that sends requests through a fetch function
 * (Electron's `net.fetch` in the app) and retries network-level failures.
 *
 * Flaky home Wi-Fi corrupts large uploads mid-stream; the server answers with a
 * TLS bad_record_mac alert. On one real network ~40% of 48 MB uploads died this
 * way — in Node, Chromium and curl alike — and the SDK does not treat that error
 * as retryable. Bodies are buffered here, so re-sending a single multipart part
 * is safe and cheap; restarting a whole video upload is neither.
 */
import { Readable } from 'node:stream'

type FetchFn = (url: string, init: RequestInit) => Promise<Response>

interface SdkRequest {
  method: string
  protocol: string
  hostname: string
  port?: number
  path: string
  query?: Record<string, string | string[] | null>
  headers: Record<string, string>
  body?: unknown
}

async function toBody(body: unknown): Promise<BodyInit | undefined> {
  if (body == null) return undefined
  if (typeof body === 'string' || body instanceof Uint8Array) return body as BodyInit
  if (typeof (body as Readable).pipe === 'function' || Symbol.asyncIterator in (body as object)) {
    const chunks: Buffer[] = []
    for await (const c of body as AsyncIterable<Buffer | string>) chunks.push(Buffer.from(c))
    return Buffer.concat(chunks)
  }
  return body as BodyInit
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function createFetchHandler(fetchFn: FetchFn, opts: { attempts?: number; backoffMs?: number } = {}) {
  const attempts = opts.attempts ?? 5
  const backoffMs = opts.backoffMs ?? 500
  return {
    metadata: { handlerProtocol: 'http/1.1' },

    async handle(request: SdkRequest, options?: { abortSignal?: AbortSignal }) {
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(request.query ?? {})) {
        for (const x of ([] as (string | null)[]).concat(v)) qs.append(k, x ?? '')
      }
      const query = qs.toString()
      const url =
        `${request.protocol}//${request.hostname}${request.port ? `:${request.port}` : ''}` +
        `${request.path}${query ? `?${query}` : ''}`

      // fetch computes Host and Content-Length itself and rejects pseudo-headers.
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(request.headers)) {
        const lower = k.toLowerCase()
        if (!k.startsWith(':') && lower !== 'host' && lower !== 'content-length') headers[k] = v
      }

      const body =
        request.method === 'GET' || request.method === 'HEAD' ? undefined : await toBody(request.body)

      // Only network errors (fetch rejecting) are retried here; HTTP error
      // responses go back to the SDK, which has its own policy for those.
      let res: Response
      for (let attempt = 1; ; attempt++) {
        try {
          res = await fetchFn(url, { method: request.method, headers, body, signal: options?.abortSignal })
          break
        } catch (e) {
          if (attempt >= attempts || options?.abortSignal?.aborted) throw e
          await sleep(backoffMs * attempt)
        }
      }

      const responseHeaders: Record<string, string> = {}
      res.headers.forEach((v, k) => (responseHeaders[k] = v))
      return {
        response: {
          statusCode: res.status,
          reason: res.statusText,
          headers: responseHeaders,
          body: res.body ? Readable.fromWeb(res.body as any) : Readable.from([]),
        },
      }
    },

    updateHttpClientConfig() {},
    httpHandlerConfigs() {
      return {}
    },
    destroy() {},
  }
}
