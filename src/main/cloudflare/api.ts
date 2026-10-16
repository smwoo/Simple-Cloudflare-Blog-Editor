/**
 * Cloudflare REST client: token verification, account discovery, R2 bucket and
 * Worker subdomain management.
 *
 * Every permission is checked independently. A half-scoped token is the most
 * common setup failure, and the difference between "missing permission to create
 * storage — tick Workers R2 Storage" and a bare 403 is minutes versus an hour,
 * even for someone technical.
 */
import type { TokenCheck } from '../../shared/types.js'

const BASE = 'https://api.cloudflare.com/client/v4'

export class CloudflareError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message)
    this.name = 'CloudflareError'
  }
}

export interface CfResponse<T> {
  success: boolean
  result: T
  errors: { code: number; message: string }[]
}

export class CloudflareClient {
  constructor(private token: string) {}

  async request<T>(
    pathname: string,
    init: RequestInit & { raw?: BodyInit } = {},
  ): Promise<T> {
    const res = await fetch(`${BASE}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(init.raw ? {} : { 'Content-Type': 'application/json' }),
        ...(init.headers ?? {}),
      },
    })

    const text = await res.text()
    let json: CfResponse<T> | undefined
    try {
      json = JSON.parse(text)
    } catch {
      /* non-JSON error body */
    }

    if (!res.ok || (json && !json.success)) {
      const err = json?.errors?.[0]
      throw new CloudflareError(
        err?.message ?? `${res.status} ${res.statusText}`,
        res.status,
        err?.code,
      )
    }
    return (json?.result ?? (undefined as T))
  }

  // ------------------------------------------------------------ identity

  /**
   * Verify the credential and report precisely which permissions are present.
   *
   * A Global API Key is detected rather than merely rejected: it is easier to
   * find in the dashboard, so it is what someone will reach for unaided, and it
   * is account-wide god mode that the app would then be storing.
   */
  async checkToken(): Promise<TokenCheck> {
    // A Global API Key is 37 hex chars and is not a bearer token at all.
    if (/^[0-9a-f]{37}$/i.test(this.token)) {
      return {
        ok: false,
        granted: [],
        missing: [],
        looksLikeGlobalKey: true,
        error:
          'That looks like a Global API Key. It grants full access to your whole ' +
          'Cloudflare account, so the app will not store it. Create a scoped API ' +
          'token instead.',
      }
    }

    // Validate via /accounts, not /user/tokens/verify: account-owned tokens
    // (cfat_…) get a 401 from the user endpoint even when fully valid.
    let accounts: { id: string; name: string }[]
    try {
      accounts = (await this.request<{ id: string; name: string }[]>('/accounts')) ?? []
    } catch (e) {
      const err = e as CloudflareError
      return {
        ok: false,
        granted: [],
        missing: [],
        optionalMissing: [],
        error:
          err.status === 400 || err.status === 401 || err.status === 403
            ? 'That token was not accepted. Check it was copied whole, and that it has not expired.'
            : err.message,
      }
    }
    if (!accounts.length) {
      return {
        ok: false,
        granted: [],
        missing: ['Account Settings — Read'],
        optionalMissing: [],
        error: 'The token cannot see any account.',
      }
    }
    const account = accounts[0]

    const granted: string[] = []
    const missing: string[] = []
    const optionalMissing: string[] = []

    for (const perm of [...REQUIRED_PERMISSIONS, ...OPTIONAL_PERMISSIONS]) {
      try {
        await perm.probe(this, account.id)
        granted.push(perm.label)
      } catch (e) {
        const err = e as CloudflareError
        // 401/403 means the permission is absent. Anything else is a real
        // outage and should not be reported as a missing tick-box.
        if (err.status !== 401 && err.status !== 403) granted.push(perm.label)
        else if (OPTIONAL_PERMISSIONS.includes(perm)) optionalMissing.push(perm.label)
        else missing.push(perm.label)
      }
    }

    return {
      ok: missing.length === 0,
      accountId: account.id,
      accountName: account.name,
      granted,
      missing,
      optionalMissing,
    }
  }

  // ------------------------------------------------------------ workers.dev

  /** The account's workers.dev subdomain, e.g. `alice` in alice.workers.dev. */
  async getWorkersSubdomain(accountId: string): Promise<string | null> {
    try {
      const r = await this.request<{ subdomain: string }>(
        `/accounts/${accountId}/workers/subdomain`,
      )
      return r?.subdomain ?? null
    } catch (e) {
      if ((e as CloudflareError).status === 404) return null
      throw e
    }
  }

  async claimWorkersSubdomain(accountId: string, subdomain: string): Promise<void> {
    await this.request(`/accounts/${accountId}/workers/subdomain`, {
      method: 'PUT',
      body: JSON.stringify({ subdomain }),
    })
  }

  // ------------------------------------------------------------ R2

  async listBuckets(accountId: string): Promise<{ name: string }[]> {
    const r = await this.request<{ buckets: { name: string }[] }>(
      `/accounts/${accountId}/r2/buckets`,
    )
    return r?.buckets ?? []
  }

  /** Idempotent: an existing bucket of the same name is adopted, not an error. */
  async createBucket(accountId: string, name: string): Promise<void> {
    try {
      await this.request(`/accounts/${accountId}/r2/buckets`, {
        method: 'POST',
        body: JSON.stringify({ name }),
      })
    } catch (e) {
      const err = e as CloudflareError
      const exists =
        err.code === 10004 || /already exists/i.test(err.message) || err.status === 409
      if (!exists) throw err
    }
  }

  // ------------------------------------------------------------ zones

  async listZones(): Promise<{ id: string; name: string; status: string }[]> {
    return (await this.request<{ id: string; name: string; status: string }[]>('/zones')) ?? []
  }

  async findZone(domain: string) {
    const zones = await this.listZones()
    return zones.find((z) => z.name === domain.toLowerCase()) ?? null
  }

  /**
   * Attach a hostname to a Worker as a Custom Domain. Cloudflare creates the
   * DNS record and orders the certificate, which is far simpler than building
   * DNS records and routes by hand.
   */
  async attachCustomDomain(
    accountId: string,
    opts: { hostname: string; zoneId: string; service: string },
  ): Promise<{ id: string }> {
    return this.request(`/accounts/${accountId}/workers/domains`, {
      method: 'PUT',
      body: JSON.stringify({
        hostname: opts.hostname,
        zone_id: opts.zoneId,
        service: opts.service,
        environment: 'production',
      }),
    })
  }

  async customDomainStatus(
    accountId: string,
    id: string,
  ): Promise<{ status?: string; certificate_status?: string }> {
    return this.request(`/accounts/${accountId}/workers/domains/${id}`)
  }
}

interface Permission {
  label: string
  /** Throws CloudflareError(403) when the permission is absent. */
  probe: (c: CloudflareClient, accountId: string) => Promise<unknown>
}

export const REQUIRED_PERMISSIONS: Permission[] = [
  {
    label: 'Account Settings — Read',
    probe: (c) => c.request('/accounts'),
  },
  {
    label: 'Workers R2 Storage — Edit',
    probe: (c, id) => c.request(`/accounts/${id}/r2/buckets`),
  },
  {
    label: 'Workers Scripts — Edit',
    probe: (c, id) => c.request(`/accounts/${id}/workers/scripts`),
  },
]

/** Only the custom-domain flow needs these; setup succeeds without them. */
export const OPTIONAL_PERMISSIONS: Permission[] = [
  {
    label: 'Zone — Read (for a custom domain)',
    probe: (c) => c.request('/zones?per_page=1'),
  },
]
