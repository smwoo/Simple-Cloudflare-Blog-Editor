/** In-memory stand-ins for the Cloudflare account: databases, bucket, Worker. */
import { readFile } from 'node:fs/promises'
import { FakeD1 } from './fakeD1.js'
import { BlogDb } from '../remote.js'
import type { CloudflareClient } from '../../cloudflare/api.js'
import type { R2 } from '../../cloudflare/r2.js'

export class FakeR2 {
  objects = new Map<string, Buffer>()
  rejectKeys = false

  private guard() {
    if (this.rejectKeys) throw Object.assign(new Error('InvalidAccessKeyId'), { $metadata: { httpStatusCode: 403 } })
  }
  async putFile(key: string, file: string) {
    this.guard()
    this.objects.set(key, await readFile(file))
  }
  async putText(key: string, body: string) {
    this.guard()
    this.objects.set(key, Buffer.from(body))
  }
  async getText(key: string) {
    this.guard()
    return this.objects.get(key)?.toString('utf8') ?? null
  }
  async list(prefix = '') {
    this.guard()
    return [...this.objects.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, v]) => ({ key, size: v.length }))
  }
  async sample(prefix = '', max = 20) {
    return (await this.list(prefix)).slice(0, max).map((o) => o.key)
  }
  async delete(key: string) {
    this.guard()
    this.objects.delete(key)
  }
  asR2() {
    return this as unknown as R2
  }
}

/** One Cloudflare account: its databases (each a real SQLite), buckets and Workers. */
export class FakeAccount {
  readonly id = 'acct1'
  readonly name = "Alice's Account"
  databases = new Map<string, { name: string; d1: FakeD1 }>()
  buckets = new Set<string>()
  workers = new Set<string>()
  subdomain = 'alice'
  domains: { id: string; hostname: string; service: string }[] = []
  /** Every request path, to prove what was and was not called. */
  requests: string[] = []

  db(uuid: string) {
    return new BlogDb(this.databases.get(uuid)!.d1)
  }

  cf(): CloudflareClient {
    const acct = this
    return {
      async request(p: string, init: RequestInit = {}) {
        acct.requests.push(`${init.method ?? 'GET'} ${p}`)
        const q = new RegExp(`^/accounts/${acct.id}/d1/database/([^/]+)/query$`).exec(p)
        if (q && init.method === 'POST') {
          const d1 = acct.databases.get(q[1])!.d1
          const { sql, params } = JSON.parse(String(init.body))
          if (!params) {
            await d1.exec(sql)
            return [{ results: [], success: true, meta: { changes: 0 } }]
          }
          const r = await d1.query(sql, params)
          return [{ results: r.rows, success: true, meta: { changes: r.changes } }]
        }
        if (p.startsWith(`/accounts/${acct.id}/d1/database`) && (init.method ?? 'GET') === 'GET') {
          return [...acct.databases.entries()].map(([uuid, d]) => ({ uuid, name: d.name }))
        }
        if (p === `/accounts/${acct.id}/d1/database` && init.method === 'POST') {
          const { name } = JSON.parse(String(init.body))
          const uuid = `db-${acct.databases.size + 1}`
          acct.databases.set(uuid, { name, d1: new FakeD1() })
          return { uuid, name }
        }
        throw Object.assign(new Error(`unexpected request ${p}`), { status: 500 })
      },
      async listAccounts() {
        return [{ id: acct.id, name: acct.name }]
      },
      async listBuckets() {
        return [...acct.buckets].map((name) => ({ name }))
      },
      async workerExists(_a: string, name: string) {
        return acct.workers.has(name)
      },
      async getWorkersSubdomain() {
        return acct.subdomain
      },
      async listCustomDomains() {
        return acct.domains
      },
    } as unknown as CloudflareClient
  }

  factories(r2: FakeR2) {
    return { cf: this.cf(), openDb: (_a: string, uuid: string) => this.db(uuid), makeR2: () => r2.asR2() }
  }
}
