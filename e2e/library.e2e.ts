import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launch, type Launched } from './harness'

let l: Launched
let libraryRoot: string

test.beforeEach(async () => {
  libraryRoot = join(mkdtempSync(join(tmpdir(), 'gallerylab-lib-')), 'galleryLAB')
  l = await launch({ env: { GALLERYLAB_DEFAULT_LIBRARY: libraryRoot } })
})

test.afterEach(async () => {
  await l.cleanup()
  rmSync(join(libraryRoot, '..'), { recursive: true, force: true })
})

const projectFolders = () =>
  readdirSync(libraryRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)

test('first run, create, rename and delete a project on disk', async () => {
  const { page } = l
  await expect(page.getByRole('heading', { name: 'Where should your Library live?' })).toBeVisible()
  await page.getByRole('button', { name: 'Use this folder' }).click()

  await expect(page.getByText('Create a project, then drop photos or folders anywhere in the window.')).toBeVisible()
  expect(existsSync(join(libraryRoot, 'library.json'))).toBe(true)

  // New project starts with its name selected for editing.
  await page.getByRole('button', { name: 'New project' }).first().click()
  const input = page.getByRole('textbox', { name: 'Project name' })
  await expect(input).toBeFocused()
  await input.fill('Coastline')
  await input.press('Enter')
  await expect(page.getByRole('heading', { name: 'Coastline' })).toBeVisible()
  await expect.poll(projectFolders).toEqual(['Coastline'])
  for (const sub of ['originals', 'exhibition', 'exhibition/history', '.gallery', 'exports']) {
    expect(existsSync(join(libraryRoot, 'Coastline', sub))).toBe(true)
  }
  const pj = JSON.parse(readFileSync(join(libraryRoot, 'Coastline', 'project.json'), 'utf8'))
  expect(pj).toMatchObject({ schemaVersion: 1, name: 'Coastline', importMode: 'copy' })

  // A second project with a colliding name gets a collision-safe folder.
  await page.getByRole('button', { name: 'New project' }).first().click()
  await page.getByRole('textbox', { name: 'Project name' }).fill('coastline')
  await page.getByRole('textbox', { name: 'Project name' }).press('Enter')
  await expect.poll(() => projectFolders().sort()).toEqual(['Coastline', 'coastline 2'])

  // Rename with F2; the folder follows.
  const card = page.getByRole('article', { name: 'Coastline', exact: true })
  await card.focus()
  await card.press('F2')
  await page.getByRole('textbox', { name: 'Project name' }).fill('Low tide: 1/2')
  await page.getByRole('textbox', { name: 'Project name' }).press('Enter')
  await expect(page.getByRole('heading', { name: 'Low tide: 1/2' })).toBeVisible()
  await expect.poll(() => projectFolders().sort()).toEqual(['Low tide 1 2', 'coastline 2'])

  // Delete through the context menu and the confirmation.
  await page.getByRole('article', { name: 'coastline' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Move to Recycle Bin/ }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Move to Recycle Bin' }).click()
  await expect.poll(projectFolders).toEqual(['Low tide 1 2'])
  await expect(page.getByRole('article')).toHaveCount(1)
})

test('projects added in Explorer appear without a restart', async () => {
  const { page } = l
  await page.getByRole('button', { name: 'Use this folder' }).click()
  await page.getByRole('button', { name: 'New project' }).first().click()
  await page.getByRole('textbox', { name: 'Project name' }).press('Enter')
  await expect(page.getByRole('article')).toHaveCount(1)
  rmSync(join(libraryRoot, 'Untitled project'), { recursive: true })
  await expect(page.getByRole('article')).toHaveCount(0, { timeout: 5000 })
})

test('theme switching follows the choice and persists', async () => {
  const { page } = l
  await page.getByRole('button', { name: 'Use this folder' }).click()
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('radio', { name: 'Darkroom' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  expect(bg).toBe('rgb(38, 38, 38)')
  await page.getByRole('radio', { name: 'Light' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.getByRole('radio', { name: 'Darkroom' }).click()
  await page.getByRole('button', { name: 'Done' }).click()

  const userData = l.userData
  await l.app.close()
  l = await launch({ userData, env: { GALLERYLAB_DEFAULT_LIBRARY: libraryRoot } })
  await expect(l.page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(l.page.getByText('Create a project, then drop photos or folders anywhere in the window.')).toBeVisible()
})

test('engine answers over RPC and the gallery scheme refuses paths outside a project', async () => {
  const { page } = l
  await page.getByRole('button', { name: 'Use this folder' }).click()
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.gallery.invoke('engine.ping').then(
          (r) => r.version,
          () => null
        )
      )
    )
    .toBe('0.1.0')

  const p = await page.evaluate(() => window.gallery.invoke('projects.create', { name: 'Proto' }))
  const ok = await page.evaluate((id) => fetch(`gallery://${id}/project.json`).then((r) => r.status), p.id)
  expect(ok).toBe(200)
  const statuses = await page.evaluate(
    (id) =>
      Promise.all(
        [
          `gallery://${id}/..%2F..%2Flibrary.json`,
          `gallery://${id}/%2e%2e/library.json`,
          `gallery://${id}/C:%5CWindows`,
          'gallery://00000000-0000-0000-0000-000000000000/project.json'
        ].map((u) =>
          fetch(u).then(
            (r) => r.status,
            () => -1
          )
        )
      ),
    p.id
  )
  for (const s of statuses) expect([403, 404, -1]).toContain(s)
})

test('the engine restarts after a crash and the window keeps working', async () => {
  const { page } = l
  await page.getByRole('button', { name: 'Use this folder' }).click()
  const ping = () =>
    page.evaluate(() =>
      window.gallery.invoke('engine.ping').then(
        (r) => r.pid,
        () => 0
      )
    )
  await expect.poll(ping).toBeGreaterThan(0)
  const first = await ping()
  process.kill(first, 'SIGKILL')
  await expect
    .poll(
      async () => {
        const pid = await ping()
        return pid > 0 && pid !== first
      },
      { timeout: 10_000 }
    )
    .toBe(true)
  await page.getByRole('button', { name: 'New project' }).first().click()
  await expect(page.getByRole('textbox', { name: 'Project name' })).toBeFocused()
})
