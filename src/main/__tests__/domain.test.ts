import { describe, it, expect, vi, beforeEach } from 'vitest'

const hugo = vi.hoisted(() => ({ baseUrl: '', builds: 0, deploys: 0 }))
vi.mock('../site/hugo.js', () => ({
  setBaseUrl: async (_dir: string, url: string) => void (hugo.baseUrl = url),
  build: async () => (hugo.builds++, { ok: true, publicDir: '/tmp/public', log: '', durationMs: 1 }),
}))
vi.mock('../cloudflare/deploy.js', () => ({
  deploySite: async () => (hugo.deploys++, { uploaded: 0, skipped: 0, totalBytes: 0 }),
}))

import { normalizeHostname, planHostnames, attachDomain, removeDomain, listBlogDomains } from '../domain.js'
import type { BlogConfig } from '../../shared/types.js'

const config: BlogConfig = {
  accountId: 'acct',
  name: 'test',
  bucket: 'test-media',
  siteUrl: 'https://test.mwoo123.workers.dev',
  title: 't',
  author: 'a',
}
const ZONES = [{ id: 'z1', name: 'cowsgomwoo.com', status: 'active' }]

/** In-memory stand-in for the Cloudflare custom-domains API. */
function fakeCf(initial: { hostname: string; service: string }[] = []) {
  let n = 0
  const domains = initial.map((d) => ({ id: `d${++n}`, ...d }))
  const cf = {
    listZones: async () => ZONES,
    listCustomDomains: async () => domains.map((d) => ({ ...d })),
    attachCustomDomain: async (_a: string, o: { hostname: string; service: string }) => {
      const existing = domains.find((d) => d.hostname === o.hostname)
      if (existing) existing.service = o.service
      else domains.push({ id: `d${++n}`, hostname: o.hostname, service: o.service })
      return { id: `d${n}` }
    },
    detachCustomDomain: async (_a: string, id: string) => {
      domains.splice(domains.findIndex((d) => d.id === id), 1)
    },
  }
  return { cf: cf as any, domains }
}

const live = async () => true

beforeEach(() => Object.assign(hugo, { baseUrl: '', builds: 0, deploys: 0 }))

describe('normalizeHostname', () => {
  it('accepts domains and subdomains, stripping scheme, path and case', () => {
    expect(normalizeHostname('cowsgomwoo.com')).toBe('cowsgomwoo.com')
    expect(normalizeHostname(' https://Test.CowsGoMwoo.com/posts/ ')).toBe('test.cowsgomwoo.com')
    expect(normalizeHostname('a.b.cowsgomwoo.com.')).toBe('a.b.cowsgomwoo.com')
  })
  it('rejects things that are not hostnames', () => {
    for (const bad of ['', 'localhost', 'has space.com', '-x.com', 'x..com', 'http://']) {
      expect(normalizeHostname(bad), bad).toBeNull()
    }
  })
})

describe('planHostnames', () => {
  it('pairs a whole domain with www', () => {
    expect(planHostnames('cowsgomwoo.com', ZONES)?.hostnames).toEqual(['cowsgomwoo.com', 'www.cowsgomwoo.com'])
  })
  it('attaches a subdomain on its own, in its parent zone', () => {
    const plan = planHostnames('test.cowsgomwoo.com', ZONES)
    expect(plan?.zone.id).toBe('z1')
    expect(plan?.hostnames).toEqual(['test.cowsgomwoo.com'])
  })
  it('does not match a lookalike domain', () => {
    expect(planHostnames('notcowsgomwoo.com', ZONES)).toBeNull()
  })
  it('prefers the most specific zone', () => {
    const zones = [...ZONES, { id: 'z2', name: 'blog.cowsgomwoo.com' }]
    expect(planHostnames('x.blog.cowsgomwoo.com', zones)?.zone.id).toBe('z2')
  })
})

describe('attachDomain', () => {
  it('attaches a subdomain, saves it as the address, rebuilds and republishes', async () => {
    const { cf, domains } = fakeCf()
    const res = await attachDomain('test.cowsgomwoo.com', { cf, config, siteDir: '/s', waitForLive: live }, () => {})
    expect(res).toMatchObject({ ok: true, attached: true, domain: 'test.cowsgomwoo.com' })
    expect(domains.map((d) => d.hostname)).toEqual(['test.cowsgomwoo.com'])
    expect(hugo.baseUrl).toBe('https://test.cowsgomwoo.com')
    expect(hugo.deploys).toBe(1)
  })

  it('refuses a hostname that another Worker serves, and leaves it alone', async () => {
    const { cf, domains } = fakeCf([{ hostname: 'blog.cowsgomwoo.com', service: 'mwoo-blog' }])
    const res = await attachDomain('blog.cowsgomwoo.com', { cf, config, siteDir: '/s', waitForLive: live }, () => {})
    expect(res.ok).toBe(false)
    expect(res.attached).toBeFalsy()
    expect(res.message).toMatch(/mwoo-blog/)
    expect(domains).toEqual([{ id: 'd1', hostname: 'blog.cowsgomwoo.com', service: 'mwoo-blog' }])
    expect(hugo.deploys).toBe(0)
  })

  it('reports an address outside the account', async () => {
    const { cf } = fakeCf()
    cf.listZones = async () => []
    vi.useFakeTimers()
    const p = attachDomain('elsewhere.org', { cf, config, siteDir: '/s', waitForLive: live }, () => {})
    await vi.runAllTimersAsync()
    const res = await p
    vi.useRealTimers()
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/cannot find elsewhere\.org/)
  })
})

describe('removeDomain', () => {
  const start = () =>
    fakeCf([
      { hostname: 'cowsgomwoo.com', service: 'test' },
      { hostname: 'www.cowsgomwoo.com', service: 'test' },
      { hostname: 'test.cowsgomwoo.com', service: 'test' },
      { hostname: 'blog.cowsgomwoo.com', service: 'mwoo-blog' },
    ])

  it('lists only this blog’s addresses, folding www into its domain', async () => {
    const { cf } = start()
    expect(await listBlogDomains(cf, { ...config, customDomain: 'test.cowsgomwoo.com' })).toEqual([
      { hostname: 'cowsgomwoo.com', withWww: true, primary: false },
      { hostname: 'test.cowsgomwoo.com', withWww: false, primary: true },
    ])
  })

  it('removes a domain together with its www twin, without touching the main address', async () => {
    const { cf, domains } = start()
    const res = await removeDomain('cowsgomwoo.com', { cf, config: { ...config, customDomain: 'test.cowsgomwoo.com' }, siteDir: '/s' })
    expect(res).toEqual({ ok: true, customDomain: 'test.cowsgomwoo.com' })
    expect(domains.map((d) => d.hostname)).toEqual(['test.cowsgomwoo.com', 'blog.cowsgomwoo.com'])
    expect(hugo.deploys).toBe(0)
  })

  it('removing the main address falls back to another attached one and republishes', async () => {
    const { cf } = start()
    const res = await removeDomain('test.cowsgomwoo.com', { cf, config: { ...config, customDomain: 'test.cowsgomwoo.com' }, siteDir: '/s' })
    expect(res).toEqual({ ok: true, customDomain: 'cowsgomwoo.com' })
    expect(hugo.baseUrl).toBe('https://cowsgomwoo.com')
    expect(hugo.deploys).toBe(1)
  })

  it('removing the last address falls back to workers.dev', async () => {
    const { cf } = fakeCf([{ hostname: 'test.cowsgomwoo.com', service: 'test' }])
    const res = await removeDomain('test.cowsgomwoo.com', { cf, config: { ...config, customDomain: 'test.cowsgomwoo.com' }, siteDir: '/s' })
    expect(res).toEqual({ ok: true, customDomain: undefined })
    expect(hugo.baseUrl).toBe(config.siteUrl)
  })

  it('will not remove an address that belongs to another Worker', async () => {
    const { cf, domains } = start()
    const res = await removeDomain('blog.cowsgomwoo.com', { cf, config, siteDir: '/s' })
    expect(res.ok).toBe(false)
    expect(domains.some((d) => d.hostname === 'blog.cowsgomwoo.com')).toBe(true)
  })
})
