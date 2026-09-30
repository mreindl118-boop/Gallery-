import { join } from 'node:path'
import { app } from 'electron'
import { AppSettings, DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION } from '@shared/schemas'
import { readJsonVersioned, writeJsonAtomic } from '@shared/node/atomic-json'
import { preserveUnreadable } from './library'

/** App-wide settings live in userData, never inside a Library or project. */
export class SettingsStore {
  private current: AppSettings = DEFAULT_SETTINGS
  private readonly file = join(app.getPath('userData'), 'settings.json')

  async load(): Promise<AppSettings> {
    try {
      this.current = (await readJsonVersioned(this.file, AppSettings, SETTINGS_SCHEMA_VERSION)) ?? DEFAULT_SETTINGS
    } catch {
      // A damaged (or newer) settings file should never stop the app from starting,
      // and is kept aside rather than overwritten by the next change.
      await preserveUnreadable(this.file)
      this.current = DEFAULT_SETTINGS
    }
    return this.current
  }

  get(): AppSettings {
    return this.current
  }

  async update(patch: Partial<Omit<AppSettings, 'schemaVersion'>>): Promise<AppSettings> {
    this.current = AppSettings.parse({ ...this.current, ...patch })
    await writeJsonAtomic(this.file, this.current)
    return this.current
  }
}
