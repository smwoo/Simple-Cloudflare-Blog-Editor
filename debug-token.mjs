#!/usr/bin/env node
// Quick debug script to test token validation
// This uses the source files directly, not the built bundle

const token = process.argv[2]
if (!token) {
  console.error('Usage: node debug-token.mjs <token>')
  process.exit(1)
}

// Simple CloudflareError class
class CloudflareError extends Error {
  constructor(message, status, code) {
    super(message)
    this.name = 'CloudflareError'
    this.status = status
    this.code = code
  }
}

// Simple CloudflareClient
class CloudflareClient {
  constructor(token) {
    this.token = token
  }

  async request(pathname, init = {}) {
    const BASE = 'https://api.cloudflare.com/client/v4'
    const res = await fetch(`${BASE}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(init.raw ? {} : { 'Content-Type': 'application/json' }),
        ...(init.headers ?? {}),
      },
    })

    const text = await res.text()
    let json
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
    return json?.result ?? undefined
  }
}

const client = new CloudflareClient(token)

async function debug() {
  console.log('Testing token...\n')
  
  // Test verify endpoint
  try {
    console.log('1. Testing /user/tokens/verify...')
    await client.request('/user/tokens/verify')
    console.log('   ✓ Token is valid\n')
  } catch (e) {
    console.log(`   ✗ Failed: ${e.status} ${e.message}\n`)
    return
  }
  
  // Test accounts
  try {
    console.log('2. Testing /accounts...')
    const accounts = await client.request('/accounts')
    console.log(`   ✓ Found ${accounts.length} accounts`)
    const account = accounts[0]
    console.log(`   Account: ${account.name} (${account.id})\n`)
    
    // Test each permission
    console.log('3. Testing permissions...')
    
    console.log('   R2 Storage:')
    try {
      await client.request(`/accounts/${account.id}/r2/buckets`)
      console.log('     ✓ Workers R2 Storage — Edit')
    } catch (e) {
      console.log(`     ✗ Workers R2 Storage — Edit (${e.status}: ${e.message})`)
    }
    
    console.log('   Workers Scripts:')
    try {
      await client.request(`/accounts/${account.id}/workers/scripts`)
      console.log('     ✓ Workers Scripts — Edit')
    } catch (e) {
      console.log(`     ✗ Workers Scripts — Edit (${e.status}: ${e.message})`)
    }
    
    console.log('   Zones (optional):')
    try {
      await client.request('/zones?per_page=1')
      console.log('     ✓ Zone — Read')
    } catch (e) {
      console.log(`     ✗ Zone — Read (${e.status}: ${e.message})`)
    }
    
  } catch (e) {
    console.log(`   ✗ Failed: ${e.message}`)
  }
}

debug().catch(console.error)
