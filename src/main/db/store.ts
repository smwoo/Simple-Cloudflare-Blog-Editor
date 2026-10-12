/**
 * Configuration and secrets.
 *
 * Config is plain JSON. Secrets go through Electron safeStorage — DPAPI-backed
 * on Windows, Keychain on macOS — and are never written in the clear, so no
 * credential sits in a readable file on the owner's machine.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { BlogConfig, Secrets } from '../../shared/types.js'

export interface SafeStorage {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

export class Store {
  private constructor(
    private dir: string,
    private safeStorage: SafeStorage,
  ) {}

  static async open(dir: string, safeStorage: SafeStorage): Promise<Store> {
    await mkdir(dir, { recursive: true })
    return new Store(dir, safeStorage)
  }

  private get configPath() {
    return path.join(this.dir, 'config.json')
  }
  private get secretsPath() {
    return path.join(this.dir, 'secrets.bin')
  }

  async readConfig(): Promise<BlogConfig | null> {
    if (!existsSync(this.configPath)) return null
    try {
      return JSON.parse(await readFile(this.configPath, 'utf8'))
    } catch {
      return null
    }
  }

  async writeConfig(config: BlogConfig): Promise<void> {
    await writeFile(this.configPath, JSON.stringify(config, null, 2), 'utf8')
  }

  async readSecrets(): Promise<Secrets | null> {
    if (!existsSync(this.secretsPath)) return null
    try {
      const blob = await readFile(this.secretsPath)
      return JSON.parse(this.safeStorage.decryptString(blob))
    } catch {
      return null
    }
  }

  async writeSecrets(secrets: Secrets): Promise<void> {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error(
        'This computer cannot store credentials securely, so the app will not ' +
          'save them. On Windows this usually means the user profile is not fully ' +
          'set up; signing out and back in normally fixes it.',
      )
    }
    await writeFile(this.secretsPath, this.safeStorage.encryptString(JSON.stringify(secrets)))
  }

  async isConfigured(): Promise<boolean> {
    return (await this.readConfig()) !== null && (await this.readSecrets()) !== null
  }

  /** Where the site, originals, outputs and caches live. */
  paths() {
    return {
      site: path.join(this.dir, 'site'),
      originals: path.join(this.dir, 'originals'),
      output: path.join(this.dir, 'media'),
      cache: path.join(this.dir, 'cache'),
      library: path.join(this.dir, 'library.json'),
      drafts: path.join(this.dir, 'drafts'),
    }
  }
}
