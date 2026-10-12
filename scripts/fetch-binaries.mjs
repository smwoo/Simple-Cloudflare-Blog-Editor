#!/usr/bin/env node
/**
 * Fetch the bundled binaries into resources/bin/<platform>-<arch>/.
 *
 * ffmpeg is deliberately NOT taken from npm: `ffmpeg-static` ships 6.1.1 and
 * `@ffmpeg-installer/ffmpeg` ships the 4.x series, while the HDR tone-mapping
 * path needs swscale colour conversion from ffmpeg >= 8. `ffmpeg-static` also
 * ships no ffprobe, which HDR detection requires.
 *
 * Hugo publishes darwin-universal and windows-amd64 extended builds but no
 * windows-arm64, which is why the app targets Windows x64 only — it runs under
 * emulation on ARM.
 *
 * Usage: node scripts/fetch-binaries.mjs [--platform darwin|win32] [--arch arm64|x64]
 */
import { mkdir, writeFile, rm, chmod, readdir, rename, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const HUGO_VERSION = '0.167.0'
const MIN_FFMPEG_MAJOR = 8

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const platform = flag('platform', process.platform)
const arch = flag('arch', process.arch)

const outDir = path.resolve('resources/bin', `${platform}-${arch}`)
const exe = (n) => (platform === 'win32' ? `${n}.exe` : n)

const HUGO_URLS = {
  'darwin-arm64': `https://github.com/gohugoio/hugo/releases/download/v${HUGO_VERSION}/hugo_extended_${HUGO_VERSION}_darwin-universal.tar.gz`,
  'darwin-x64': `https://github.com/gohugoio/hugo/releases/download/v${HUGO_VERSION}/hugo_extended_${HUGO_VERSION}_darwin-universal.tar.gz`,
  'win32-x64': `https://github.com/gohugoio/hugo/releases/download/v${HUGO_VERSION}/hugo_extended_${HUGO_VERSION}_windows-amd64.zip`,
}

// Pinned ffmpeg >= 8 builds. evermeet (macOS) and BtbN (Windows) both publish
// static builds; BtbN's are versioned by release tag.
const FFMPEG_URLS = {
  'darwin-arm64': ['https://evermeet.cx/ffmpeg/getrelease/zip', 'https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip'],
  'darwin-x64': ['https://evermeet.cx/ffmpeg/getrelease/zip', 'https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip'],
  'win32-x64': ['https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'],
}

async function download(url, dest) {
  console.log(`  ↓ ${url}`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  await writeFile(dest, Buffer.from(await res.arrayBuffer()))
}

function extract(archive, into) {
  if (archive.endsWith('.zip')) execFileSync('unzip', ['-o', '-q', archive, '-d', into])
  else execFileSync('tar', ['-xzf', archive, '-C', into])
}

/** Find a binary anywhere under `dir` and move it to `outDir`. */
async function hoist(dir, name) {
  const want = exe(name)
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.name === want) {
        await rename(full, path.join(outDir, want))
        if (platform !== 'win32') await chmod(path.join(outDir, want), 0o755)
        return true
      }
    }
  }
  return false
}

async function main() {
  const key = `${platform}-${arch}`
  if (!HUGO_URLS[key]) {
    console.error(`No binaries published for ${key}.`)
    if (key === 'win32-arm64') {
      console.error('Hugo extended has no windows-arm64 build. Ship x64; it runs under emulation.')
    }
    process.exit(1)
  }

  await mkdir(outDir, { recursive: true })
  const tmp = path.resolve('.scratch/bin-fetch', key)
  await rm(tmp, { recursive: true, force: true })
  await mkdir(tmp, { recursive: true })

  console.log(`\nHugo ${HUGO_VERSION} for ${key}`)
  const hugoArchive = path.join(tmp, path.basename(new URL(HUGO_URLS[key]).pathname))
  await download(HUGO_URLS[key], hugoArchive)
  extract(hugoArchive, tmp)
  if (!(await hoist(tmp, 'hugo'))) throw new Error('hugo binary not found in archive')

  console.log(`\nffmpeg (>= ${MIN_FFMPEG_MAJOR}) for ${key}`)
  for (const url of FFMPEG_URLS[key]) {
    const dest = path.join(tmp, `ff-${Math.random().toString(36).slice(2)}.zip`)
    await download(url, dest)
    extract(dest, tmp)
  }
  if (!(await hoist(tmp, 'ffmpeg'))) throw new Error('ffmpeg binary not found in archive')
  if (!(await hoist(tmp, 'ffprobe'))) throw new Error('ffprobe binary not found in archive')

  // Assert the version here, at build time, so a stale mirror fails the build
  // rather than producing washed-out video months later.
  if (platform === process.platform && arch === process.arch) {
    const out = execFileSync(path.join(outDir, exe('ffmpeg')), ['-hide_banner', '-version'], {
      encoding: 'utf8',
    })
    const m = /ffmpeg version n?(\d+)\./.exec(out)
    if (!m || Number(m[1]) < MIN_FFMPEG_MAJOR) {
      throw new Error(
        `bundled ffmpeg is ${m?.[1] ?? 'unknown'}, need >= ${MIN_FFMPEG_MAJOR} for the HDR path`,
      )
    }
    console.log(`\n  ffmpeg ${m[1]}.x ✓`)
  }

  await rm(tmp, { recursive: true, force: true })
  for (const n of ['hugo', 'ffmpeg', 'ffprobe']) {
    const f = path.join(outDir, exe(n))
    const { size } = await stat(f)
    console.log(`  ${exe(n).padEnd(12)} ${(size / 1e6).toFixed(1)} MB`)
  }
  console.log(`\nDone → resources/bin/${key}\n`)
}

main().catch((e) => {
  console.error(`\nFailed: ${e.message}\n`)
  process.exit(1)
})
