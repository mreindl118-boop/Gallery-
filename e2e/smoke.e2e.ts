import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launch } from './harness'

// Launches whatever build the harness points at (dev output or a packaged
// executable via GALLERYLAB_EXECUTABLE) and checks the core loop works.
test('app launches, the engine starts and a project can be created', async () => {
  const lib = join(mkdtempSync(join(tmpdir(), 'gallerylab-smoke-')), 'galleryLAB')
  const l = await launch({ env: { GALLERYLAB_DEFAULT_LIBRARY: lib } })
  try {
    await l.page.getByRole('button', { name: 'Use this folder' }).click()
    await l.page.getByRole('button', { name: 'New project' }).first().click()
    await l.page.getByRole('textbox', { name: 'Project name' }).press('Enter')
    await expect(l.page.getByRole('heading', { name: 'Untitled project' })).toBeVisible()
    await expect
      .poll(() =>
        l.page.evaluate(() =>
          window.gallery.invoke('engine.ping').then(
            (r) => r.pid > 0,
            () => false
          )
        )
      )
      .toBe(true)
  } finally {
    await l.cleanup()
    rmSync(join(lib, '..'), { recursive: true, force: true })
  }
})
