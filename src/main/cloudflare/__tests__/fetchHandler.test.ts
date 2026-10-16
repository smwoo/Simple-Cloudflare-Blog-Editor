import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import { createFetchHandler } from '../fetchHandler.js'

const request = (over: Record<string, unknown> = {}) => ({
  method: 'PUT',
  protocol: 'https:',
  hostname: 'acct.r2.cloudflarestorage.com',
  path: '/bucket/key.mp4',
  query: { partNumber: '2', uploadId: 'abc' },
  headers: { host: 'acct.r2.cloudflarestorage.com', 'content-length': '5', ':authority': 'x', 'x-amz-date': 'd' },
  body: Buffer.from('hello'),
  ...over,
})

function fakeFetch(script: Array<'net' | number>) {
  const calls: { url: string; init: RequestInit }[] = []
  const fn = async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const step = script[Math.min(calls.length - 1, script.length - 1)]
    if (step === 'net') throw new Error('net::ERR_SSL_BAD_RECORD_MAC_ALERT')
    return new Response(step === 200 ? 'ok' : 'err', { status: step, headers: { etag: '"e"' } })
  }
  return { fn, calls }
}

describe('fetch request handler', () => {
  it('builds the URL and strips headers fetch rejects or computes itself', async () => {
    const { fn, calls } = fakeFetch([200])
    const { response } = await createFetchHandler(fn).handle(request())
    expect(calls[0].url).toBe('https://acct.r2.cloudflarestorage.com/bucket/key.mp4?partNumber=2&uploadId=abc')
    expect(Object.keys(calls[0].init.headers as object)).toEqual(['x-amz-date'])
    expect(response.statusCode).toBe(200)
    expect(response.headers.etag).toBe('"e"')
  })

  it('retries network failures and re-sends the identical body', async () => {
    const { fn, calls } = fakeFetch(['net', 'net', 200])
    const { response } = await createFetchHandler(fn, { backoffMs: 1 }).handle(request())
    expect(response.statusCode).toBe(200)
    expect(calls).toHaveLength(3)
    for (const c of calls) expect(Buffer.from(c.init.body as Uint8Array).toString()).toBe('hello')
  })

  it('buffers a stream body once so it can be replayed', async () => {
    const { fn, calls } = fakeFetch(['net', 200])
    await createFetchHandler(fn, { backoffMs: 1 }).handle(request({ body: Readable.from([Buffer.from('he'), Buffer.from('llo')]) }))
    expect(calls.map((c) => Buffer.from(c.init.body as Uint8Array).toString())).toEqual(['hello', 'hello'])
  })

  it('gives up after the attempt limit', async () => {
    const { fn, calls } = fakeFetch(['net'])
    await expect(createFetchHandler(fn, { attempts: 3, backoffMs: 1 }).handle(request())).rejects.toThrow('BAD_RECORD_MAC')
    expect(calls).toHaveLength(3)
  })

  it('does not retry HTTP error responses — those are the SDK’s to judge', async () => {
    const { fn, calls } = fakeFetch([500, 200])
    const { response } = await createFetchHandler(fn, { backoffMs: 1 }).handle(request())
    expect(response.statusCode).toBe(500)
    expect(calls).toHaveLength(1)
  })

  it('sends no body for GET/HEAD', async () => {
    const { fn, calls } = fakeFetch([200])
    await createFetchHandler(fn).handle(request({ method: 'HEAD' }))
    expect(calls[0].init.body).toBeUndefined()
  })
})
