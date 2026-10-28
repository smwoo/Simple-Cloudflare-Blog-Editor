/**
 * Disconnecting this computer from its blog.
 *
 * Everything the app knows about a blog lives in one folder, so disconnecting
 * is setting that folder aside: the next start finds no blog and opens on
 * setup. It is renamed, never deleted — original photos and unshared drafts
 * may exist nowhere else.
 *
 * The rename happens at the next start, before anything opens the folder.
 * While the app runs, the media queue, sync state and preview server all hold
 * files in it, and Windows will not rename a folder with open files.
 */
import { existsSync } from 'node:fs'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const MARKER = 'disconnect-pending'

/** Ask for the blog folder to be set aside at the next start. */
export async function requestDisconnect(userData: string): Promise<void> {
  await writeFile(path.join(userData, MARKER), new Date().toISOString(), 'utf8')
}

/**
 * If a disconnect was requested, move `dataDir` aside. Returns where it went,
 * or null if there was nothing to do.
 */
export async function applyPendingDisconnect(
  userData: string,
  dataDir: string,
  now = new Date(),
): Promise<string | null> {
  const marker = path.join(userData, MARKER)
  if (!existsSync(marker)) return null
  const requested = await readFile(marker, 'utf8').catch(() => '')
  let moved: string | null = null
  if (existsSync(dataDir)) {
    moved = asideName(dataDir, requested ? new Date(requested) : now)
    await rename(dataDir, moved)
  }
  await rm(marker, { force: true })
  return moved
}

/** `blog-disconnected-2026-10-27-1405`, with a suffix if that is taken. */
function asideName(dataDir: string, when: Date): string {
  const stamp = (isNaN(when.getTime()) ? new Date() : when)
    .toISOString()
    .slice(0, 16)
    .replace('T', '-')
    .replace(':', '')
  const base = `${dataDir}-disconnected-${stamp}`
  let name = base
  for (let n = 2; existsSync(name); n++) name = `${base}-${n}`
  return name
}
