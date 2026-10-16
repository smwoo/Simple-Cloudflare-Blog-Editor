#!/usr/bin/env node
// Quick debug script to test token validation
import { CloudflareClient } from './out/main/index.js'

const token = process.argv[2]
if (!token) {
  console.error('Usage: node debug-token.mjs <token>')
  process.exit(1)
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
    
    console.log('   Zones:')
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
