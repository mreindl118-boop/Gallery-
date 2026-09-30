import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launch, type Launched } from './harness'

let l: Launched
let parent: string
let libraryRoot: string

test.beforeEach(async () => {
  parent = mkdtempSync(join(tmpdir(), 'gallerylab-rob-'))
  libraryRoot = join(parent, 'galleryLAB')
  l = await launch({ env: { GALLERYLAB_DEFAULT_LIBRARY: libraryRoot } })
  await l.page.getByRole('button', { name: 'Use this folder' }).click()
  await expect(l.page.getByText('Create a project, then drop photos or folders anywhere in the window.')).toBeVisible()
})

test.afterEach(async () => {
  await l.cleanup()
  rmSync(parent, { recursive: true, force: true })
})

test('a moved Library is reported, not recreated empty, and found again with Try again', async () => {
  await l.page.evaluate(() => window.gallery.invoke('projects.create', { name: 'Kept' }))
  const userData = l.userData
  await l.app.close()
  const moved = join(parent, 'galleryLAB moved')
  renameSync(libraryRoot, moved)

  l = await launch({ userData, env: { GALLERYLAB_DEFAULT_LIBRARY: libraryRoot } })
  await expect(l.page.getByRole('heading', { name: 'Your Library folder isn’t available' })).toBeVisible()
  await expect(l.page.getByText('galleryLAB can’t find this folder.', { exact: false })).toBeVisible()
  expect(existsSync(libraryRoot)).toBe(false)

  // Try again does not create it either.
  await l.page.getByRole('button', { name: 'Try again' }).click()
  await expect(l.page.getByText('can’t find', { exact: false }).first()).toBeVisible()
  expect(existsSync(libraryRoot)).toBe(false)

  // Put it back: Try again opens it with its project.
  renameSync(moved, libraryRoot)
  await l.page.getByRole('button', { name: 'Try again' }).click()
  await expect(l.page.getByRole('heading', { name: 'Kept' })).toBeVisible()
})

test('changing to a folder that cannot be used keeps the current Library open', async () => {
  const { page } = l
  await page.evaluate(() => window.gallery.invoke('projects.create', { name: 'Still here' }))
  const file = join(parent, 'a file, not a folder')
  writeFileSync(file, 'x')
  const err = await page.evaluate(
    (p) =>
      window.gallery.invoke('library.setLocation', { path: p }).then(
        () => null,
        (e: Error) => e.message
      ),
    file
  )
  expect(err).toMatch(/can’t write to/)
  const list = await page.evaluate(() => window.gallery.invoke('projects.list'))
  expect(list.map((p) => p.name)).toEqual(['Still here'])
})

test('rename from the context menu puts the cursor in the name field', async () => {
  const { page } = l
  await page.evaluate(() => window.gallery.invoke('projects.create', { name: 'Coast' }))
  await page.reload()
  const card = page.getByRole('article', { name: 'Coast' })
  await card.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Rename/ }).click()
  const input = page.getByRole('textbox', { name: 'Project name' })
  await expect(input).toBeFocused()
  await page.keyboard.type('Low tide')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Low tide' })).toBeVisible()
})

test('focus returns to where it was when a dialog closes', async () => {
  const { page } = l
  const settings = page.getByRole('button', { name: 'Settings' })
  await settings.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(settings).toBeFocused()

  await page.evaluate(() => window.gallery.invoke('projects.create', { name: 'Keep me' }))
  await page.reload()
  const card = page.getByRole('article', { name: 'Keep me' })
  await card.focus()
  await card.press('Delete')
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
  await expect(card).toBeFocused()
})

test('arrow keys move through the theme choices', async () => {
  const { page } = l
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.getByRole('button', { name: 'Settings' }).click()
  const light = page.getByRole('radio', { name: 'Light' })
  await page.getByRole('radio', { name: 'Follow Windows' }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(light).toBeFocused()
  await expect(light).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  expect(errors).toEqual([])
})

test('Ctrl+N does nothing while a dialog is open', async () => {
  const { page } = l
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Control+n')
  await page.waitForTimeout(400)
  expect(await page.evaluate(() => window.gallery.invoke('projects.list'))).toEqual([])
})

test('dropping photos on the Library outside a project says to open a project first', async () => {
  const { page } = l
  await page.evaluate(() => {
    const dt = new DataTransfer()
    dt.items.add(new File(['x'], 'photo.jpg', { type: 'image/jpeg' }))
    document.body.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })
  await expect(page.getByText('Open a project, then drop photos or folders into it.')).toBeVisible()
})
