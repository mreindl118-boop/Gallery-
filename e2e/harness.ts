import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'

export interface Launched {
  app: ElectronApplication
  page: Page
  userData: string
  cleanup: () => Promise<void>
}

/** Launch the built app with an isolated userData folder. */
export async function launch(opts: { userData?: string; env?: Record<string, string> } = {}): Promise<Launched> {
  const userData = opts.userData ?? mkdtempSync(join(tmpdir(), 'gallerylab-ud-'))
  // GALLERYLAB_EXECUTABLE points at a packaged build for smoke tests.
  const executablePath = process.env['GALLERYLAB_EXECUTABLE']
  const args = executablePath ? [] : [resolve(__dirname, '..')]
  if (process.platform === 'linux') args.push('--no-sandbox')
  const app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args,
    env: { ...process.env, GALLERYLAB_USER_DATA: userData, ...opts.env } as Record<string, string>
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return {
    app,
    page,
    userData,
    cleanup: async () => {
      await app.close().catch(() => undefined)
      if (!opts.userData) rmSync(userData, { recursive: true, force: true })
    }
  }
}
