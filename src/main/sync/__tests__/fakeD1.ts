/** D1 backed by an in-memory SQLite, so tests run the real SQL. */
import { createRequire } from 'node:module'
// Loaded through require: Vite does not yet know node:sqlite is a builtin.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
import type { D1, D1Result, SqlValue } from '../../cloudflare/d1.js'

export class FakeD1 implements D1 {
  readonly db: InstanceType<typeof DatabaseSync> = new DatabaseSync(':memory:')
  /** Set to make every call fail, as when offline. */
  offline = false
  calls = 0

  async query<T>(sql: string, params: SqlValue[] = []): Promise<D1Result<T>> {
    this.calls++
    if (this.offline) throw new Error('fetch failed')
    const stmt = this.db.prepare(sql)
    if (/^\s*(SELECT|WITH)/i.test(sql)) {
      return { rows: stmt.all(...params) as T[], changes: 0 }
    }
    // Like D1, a write with RETURNING answers with its rows.
    if (/\bRETURNING\b/i.test(sql)) {
      const rows = stmt.all(...params) as T[]
      return { rows, changes: rows.length }
    }
    const r = stmt.run(...params)
    return { rows: [], changes: Number(r.changes) }
  }

  async exec(sql: string): Promise<void> {
    this.calls++
    if (this.offline) throw new Error('fetch failed')
    this.db.exec(sql)
  }
}
