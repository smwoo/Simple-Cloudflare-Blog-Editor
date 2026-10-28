import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { requestDisconnect, applyPendingDisconnect } from '../disconnect.js'

let userData: string
let blog: string

beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), 'disconnect-'))
  blog = path.join(userData, 'blog')
  await mkdir(blog)
  await writeFile(path.join(blog, 'config.json'), '{"name":"old"}')
})
afterEach(() => rm(userData, { recursive: true, force: true }))

describe('disconnect', () => {
  it('does nothing unless asked', async () => {
    expect(await applyPendingDisconnect(userData, blog)).toBeNull()
    expect(existsSync(path.join(blog, 'config.json'))).toBe(true)
  })

  it('sets the blog folder aside, intact, at the next start', async () => {
    await requestDisconnect(userData)
    // Nothing moves while the app is still running.
    expect(existsSync(blog)).toBe(true)

    const moved = await applyPendingDisconnect(userData, blog)
    expect(moved).toMatch(/blog-disconnected-\d{4}-\d{2}-\d{2}-\d{4}$/)
    expect(existsSync(blog)).toBe(false)
    expect(await readFile(path.join(moved!, 'config.json'), 'utf8')).toBe('{"name":"old"}')

    // Only once: the following start is an ordinary one.
    expect(await applyPendingDisconnect(userData, blog)).toBeNull()
  })

  it('never overwrites an earlier set-aside folder', async () => {
    const when = new Date('2026-10-27T14:05:00Z')
    await requestDisconnect(userData)
    await writeFile(path.join(userData, 'disconnect-pending'), when.toISOString())
    const first = await applyPendingDisconnect(userData, blog)

    await mkdir(blog)
    await requestDisconnect(userData)
    await writeFile(path.join(userData, 'disconnect-pending'), when.toISOString())
    const second = await applyPendingDisconnect(userData, blog)

    expect(first).not.toBe(second)
    expect(second).toBe(`${first}-2`)
    expect((await readdir(userData)).sort()).toEqual([path.basename(first!), path.basename(second!)].sort())
  })

  it('clears the request even when there is no blog folder', async () => {
    await rm(blog, { recursive: true })
    await requestDisconnect(userData)
    expect(await applyPendingDisconnect(userData, blog)).toBeNull()
    expect(existsSync(path.join(userData, 'disconnect-pending'))).toBe(false)
  })
})
