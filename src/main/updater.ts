/**
 * Auto-update.
 *
 * This matters more than it looks. electron-updater downloads the new installer
 * itself rather than through a browser, so the file generally does not pick up
 * the Mark of the Web and SmartScreen does not fire. With an unsigned app that
 * makes the "Windows protected your PC" dialog a ONE-TIME event per person
 * rather than something they meet on every release — which is what makes
 * shipping unsigned a durable answer instead of a postponement.
 *
 * Conversely, emailing a new .exe each time means hitting the dialog every
 * release. Set this up from release one.
 */
import { app } from 'electron'

export interface UpdateState {
  checking: boolean
  available?: string
  downloaded?: boolean
  error?: string
}

let state: UpdateState = { checking: false }
export const updateState = () => state

export async function initUpdater(notify: (s: UpdateState) => void): Promise<void> {
  // Never in development, and never from a non-packaged build.
  if (!app.isPackaged) return

  let autoUpdater: any
  try {
    ;({ autoUpdater } = await import('electron-updater'))
  } catch {
    return
  }

  autoUpdater.autoDownload = true
  // Applying on quit keeps the writer out of a restart they did not ask for.
  autoUpdater.autoInstallOnAppQuit = true

  const set = (patch: Partial<UpdateState>) => {
    state = { ...state, ...patch }
    notify(state)
  }

  autoUpdater.on('checking-for-update', () => set({ checking: true, error: undefined }))
  autoUpdater.on('update-not-available', () => set({ checking: false }))
  autoUpdater.on('update-available', (info: any) =>
    set({ checking: false, available: info?.version }),
  )
  autoUpdater.on('update-downloaded', () => set({ checking: false, downloaded: true }))
  // An update failure must never interrupt writing: it is logged and retried.
  autoUpdater.on('error', (e: Error) => set({ checking: false, error: e.message }))

  await autoUpdater.checkForUpdates().catch(() => {})
  // A quiet daily re-check is enough for a blog written once a month.
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 24 * 60 * 60 * 1000)
}

/**
 * Refuse to publish from a build older than the floor.
 *
 * Prevents someone who never restarts from writing posts with a stale
 * serializer, which would be invisible until the output looked wrong.
 */
export const MINIMUM_VERSION = '0.1.0'

export function versionBelow(a: string, b: string): boolean {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return true
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return false
  }
  return false
}
