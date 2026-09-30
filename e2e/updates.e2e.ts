import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launch } from './harness'

// Drives the Updates UI against the development stand-in backend
// (GALLERYLAB_UPDATE_FAKE). The real installer and portable updaters are
// exercised on Windows by scripts/ci/update-test.ps1.
test('an update is found, downloaded, announced and installed from Settings', async () => {
  const lib = join(mkdtempSync(join(tmpdir(), 'gallerylab-upd-')), 'galleryLAB')
  const l = await launch({
    env: { GALLERYLAB_DEFAULT_LIBRARY: lib, GALLERYLAB_UPDATE_FAKE: '1', GALLERYLAB_UPDATE_CHECK_DELAY_MS: '200' }
  })
  const { page } = l
  try {
    await page.getByRole('button', { name: 'Use this folder' }).click()
    // Automatic check → background download → one quiet notice with the action.
    await expect(
      page.getByText('galleryLAB 9.9.9 is ready. It installs the next time you open galleryLAB.').first()
    ).toBeVisible({
      timeout: 10_000
    })
    await expect(page.getByRole('button', { name: 'Restart to update' })).toBeVisible()

    await page.getByRole('button', { name: 'Settings' }).click()
    const dialog = page.getByRole('dialog')
    await expect(
      dialog.getByText('galleryLAB 9.9.9 is ready. It installs the next time you open galleryLAB.')
    ).toBeVisible()
    await expect(
      dialog.getByText('galleryLAB stays in the folder you installed it to.', { exact: false })
    ).toBeVisible()
    await dialog.getByRole('button', { name: 'Restart to update' }).click()
    // The window says what is happening before galleryLAB closes to install.
    await expect(page.getByRole('alertdialog', { name: 'Updating galleryLAB' })).toBeVisible()
    await expect(dialog.getByText('galleryLAB 9.9.9 is up to date.')).toBeVisible({ timeout: 5000 })
    await expect(page.getByRole('alertdialog', { name: 'Updating galleryLAB' })).toHaveCount(0)

    // Turning automatic updates off is saved.
    const box = dialog.getByRole('checkbox', { name: /Update automatically/ })
    await expect(box).toBeChecked()
    await box.uncheck()
    await expect(box).not.toBeChecked()
    await expect.poll(() => JSON.parse(readFileSync(join(l.userData, 'settings.json'), 'utf8')).autoUpdate).toBe(false)

    // With automatic updates off, a manual check offers the download instead of starting it.
    await dialog.getByRole('button', { name: 'Check for updates' }).click()
    await expect(dialog.getByText('galleryLAB 9.9.9 is available.')).toBeVisible()
    await dialog.getByRole('button', { name: 'Download' }).click()
    await expect(dialog.getByRole('button', { name: 'Restart to update' })).toBeVisible()
  } finally {
    await l.cleanup()
    rmSync(join(lib, '..'), { recursive: true, force: true })
  }
})

test('development builds say updates come from the installed app', async () => {
  const lib = join(mkdtempSync(join(tmpdir(), 'gallerylab-upd-')), 'galleryLAB')
  const l = await launch({ env: { GALLERYLAB_DEFAULT_LIBRARY: lib } })
  try {
    await l.page.getByRole('button', { name: 'Use this folder' }).click()
    await l.page.getByRole('button', { name: 'Settings' }).click()
    await expect(l.page.getByText('Updates are checked by the installed app.', { exact: false })).toBeVisible()
  } finally {
    await l.cleanup()
    rmSync(join(lib, '..'), { recursive: true, force: true })
  }
})
