import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import sharp from 'sharp'
import { launch, type Launched } from './harness'

let l: Launched
let parent: string
let libraryRoot: string

test.beforeEach(async () => {
  parent = mkdtempSync(join(tmpdir(), 'gallerylab-build-'))
  libraryRoot = join(parent, 'galleryLAB')
  l = await launch({ env: { GALLERYLAB_DEFAULT_LIBRARY: libraryRoot } })
  await l.page.getByRole('button', { name: 'Use this folder' }).click()
  await expect(l.page.getByText('Create a project, then drop photos or folders anywhere in the window.')).toBeVisible()
})

test.afterEach(async () => {
  await l.cleanup()
  rmSync(parent, { recursive: true, force: true })
})

test('a project with photos shows its build state and offers to build now', async () => {
  const { page } = l
  const src = join(parent, 'Photos')
  mkdirSync(src)
  await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 90, g: 120, b: 160 } } })
    .jpeg()
    .toFile(join(src, 'one.jpg'))

  const p = await page.evaluate(() => window.gallery.invoke('projects.create', { name: 'Harbour' }))
  await page.evaluate((a) => window.gallery.invoke('import.add', a), { id: p.id, paths: [src] })
  await expect(page.getByRole('article', { name: 'Harbour', exact: true })).toContainText('1 photo')

  await page.getByRole('article', { name: 'Harbour', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Harbour', level: 1 })).toBeVisible()
  const build = page.getByRole('region', { name: 'Build' })
  await expect(build).toContainText('Reading')
  await expect(build).toContainText('Theming')
  await expect(build).toContainText('Making assets')

  // A stocked project builds on its own: reading and theming finish without a
  // generator, and the panel says what is needed for assets.
  await expect(build).toContainText('Themed', { timeout: 30_000 })
  await expect(build).toContainText('Add a generator key in Settings to make assets.')
  await expect(build.getByRole('progressbar', { name: 'Build progress' })).toHaveAttribute('aria-valuenow', '100')

  // Build now runs it again from the start and lands in the same place.
  await build.getByRole('button', { name: 'Build now' }).click()
  await expect(build).toContainText('Themed', { timeout: 30_000 })
  await expect(build.getByRole('button', { name: 'Build now' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Generated' })).toHaveCount(0)
})

test('Settings has a Generator section whose provider and key persist', async () => {
  const { page } = l
  await page.getByRole('button', { name: 'Settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog.getByRole('heading', { name: 'Generator' })).toBeVisible()
  await expect(dialog.getByText('Keys are stored encrypted on this PC and never written into a project.')).toBeVisible()
  await expect(dialog.getByRole('radio', { name: 'None' })).toHaveAttribute('aria-checked', 'true')

  await dialog.getByRole('radio', { name: 'Stability AI' }).click()
  await expect(dialog.getByRole('radio', { name: 'Stability AI' })).toHaveAttribute('aria-checked', 'true')
  await expect
    .poll(() => page.evaluate(() => window.gallery.invoke('generator.settings')))
    .toMatchObject({
      provider: 'stability',
      hasKey: { stability: false }
    })

  // Headless Linux has no keyring; let Electron's safeStorage use its plain-text fallback for this test.
  await l.app.evaluate(({ safeStorage }) => safeStorage.setUsePlainTextEncryption(true))

  const field = dialog.getByLabel('Stability AI key')
  await expect(field).toHaveAttribute('type', 'password')
  await field.fill('sk-test-not-a-real-key')
  await dialog.getByRole('button', { name: 'Save key' }).click()
  await expect(dialog.getByText('A key is saved.')).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => window.gallery.invoke('generator.settings')))
    .toMatchObject({
      hasKey: { stability: true }
    })

  // Limits save on blur and come back as saved.
  await dialog.getByLabel('Images per build').fill('20')
  await dialog.getByLabel('Spend cap in US dollars').fill('2.5')
  await dialog.getByRole('button', { name: 'Check key' }).focus()
  await expect
    .poll(() => page.evaluate(() => window.gallery.invoke('generator.settings')))
    .toMatchObject({
      imagesPerBuild: 20,
      spendCapUsd: 2.5
    })

  await dialog.getByRole('button', { name: 'Remove' }).click()
  await expect(dialog.getByText('A key is saved.')).toHaveCount(0)
  await expect(dialog.getByLabel('Stability AI key')).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => window.gallery.invoke('generator.settings')))
    .toMatchObject({
      hasKey: { stability: false }
    })

  await dialog.getByRole('button', { name: 'Done' }).click()
  const userData = l.userData
  await l.app.close()
  l = await launch({ userData, env: { GALLERYLAB_DEFAULT_LIBRARY: libraryRoot } })
  await l.page.getByRole('button', { name: 'Settings' }).click()
  await expect(l.page.getByRole('radio', { name: 'Stability AI' })).toHaveAttribute('aria-checked', 'true')
})
