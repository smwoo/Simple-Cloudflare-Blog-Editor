/**
 * D1 over the Cloudflare REST API.
 *
 * The app talks to the owner's database with the token it already holds. The
 * Worker never binds it, so the public site gains nothing new to attack.
 *
 * Everything above this file sees only the `D1` interface, which is what lets
 * the tests run the real SQL against an in-memory SQLite.
 */
import type { CloudflareClient } from './api.js'

export type SqlValue = string | number | null

export interface D1Result<T> {
  rows: T[]
  /** Rows written by an INSERT/UPDATE/DELETE. */
  changes: number
}

export interface D1 {
  query<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<D1Result<T>>
  /** Several statements, no parameters: schema only. */
  exec(sql: string): Promise<void>
}

export interface D1Database {
  uuid: string
  name: string
}

interface QueryResponse<T> {
  results: T[]
  success: boolean
  meta?: { changes?: number }
}

export class RestD1 implements D1 {
  constructor(
    private cf: CloudflareClient,
    private accountId: string,
    readonly databaseId: string,
  ) {}

  private get endpoint() {
    return `/accounts/${this.accountId}/d1/database/${this.databaseId}/query`
  }

  async query<T>(sql: string, params: SqlValue[] = []): Promise<D1Result<T>> {
    const res = await this.cf.request<QueryResponse<T>[]>(this.endpoint, {
      method: 'POST',
      body: JSON.stringify({ sql, params }),
    })
    const first = res?.[0]
    return { rows: first?.results ?? [], changes: first?.meta?.changes ?? 0 }
  }

  async exec(sql: string): Promise<void> {
    await this.cf.request(this.endpoint, { method: 'POST', body: JSON.stringify({ sql }) })
  }
}

export async function listDatabases(cf: CloudflareClient, accountId: string): Promise<D1Database[]> {
  const out: D1Database[] = []
  for (let page = 1; page < 50; page++) {
    const batch =
      (await cf.request<D1Database[]>(
        `/accounts/${accountId}/d1/database?per_page=100&page=${page}`,
      )) ?? []
    out.push(...batch)
    if (batch.length < 100) break
  }
  return out
}

/** Idempotent, like the bucket: an existing database of the same name is adopted. */
export async function ensureDatabase(
  cf: CloudflareClient,
  accountId: string,
  name: string,
): Promise<D1Database> {
  const existing = (await listDatabases(cf, accountId)).find((d) => d.name === name)
  if (existing) return existing
  return cf.request<D1Database>(`/accounts/${accountId}/d1/database`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

export async function deleteDatabase(cf: CloudflareClient, accountId: string, uuid: string): Promise<void> {
  await cf.request(`/accounts/${accountId}/d1/database/${uuid}`, { method: 'DELETE' })
}

/** `alice-blog` → `alice-blog-db`. */
export const databaseName = (blogName: string) => `${blogName}-db`
