import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import sharp from 'sharp'
import { video } from '../tests/fixtures/videos'
import { launch, type Launched } from './harness'

let l: Launched
let parent: string
let libraryRoot: string
let sources: string

/** A small, distinct photo: a flat color plus a band, so every file hashes differently. */
async function photo(path: string, i: number, width = 640, height = 480): Promise<void> {
  const band = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect x="0" y="${(i * 37) % height}" width="${width}" height="24" fill="rgb(${(i * 53) % 255},40,90)"/></svg>`
  )
  await sharp({ create: { width, height, channels: 3, background: { r: (i * 29) % 255, g: 120, b: (i * 71) % 255 } } })
    .composite([{ input: band }])
    .jpeg({ quality: 80 })
    .toFile(path)
}

/** 10 photos in two subfolders (one portrait), one exact duplicate, one corrupt JPEG and one text file. */
async function makeSources(): Promise<void> {
  mkdirSync(join(sources, 'Trip', 'Day 1'), { recursive: true })
  mkdirSync(join(sources, 'Trip', 'Day 2'), { recursive: true })
  for (let i = 0; i < 6; i++) await photo(join(sources, 'Trip', 'Day 1', `IMG_${1000 + i}.jpg`), i)
  for (let i = 6; i < 9; i++) await photo(join(sources, 'Trip', 'Day 2', `IMG_${1000 + i}.jpg`), i)
  await photo(join(sources, 'Trip', 'Day 2', 'IMG_1009.jpg'), 9, 480, 720)
  await sharp(join(sources, 'Trip', 'Day 1', 'IMG_1000.jpg')).toFile(join(sources, 'Trip', 'Day 2', 'copy.png'))
  // An exact byte copy is a duplicate; the PNG above is a different file of the same picture.
  copyFileSync(join(sources, 'Trip', 'Day 1', 'IMG_1000.jpg'), join(sources, 'Trip', 'Day 2', 'IMG_1000 copy.jpg'))
  writeFileSync(
    join(sources, 'Trip', 'broken.jpg'),
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)])
  )
  writeFileSync(join(sources, 'Trip', 'notes.txt'), 'Not a photo.')
}

/** Make the native pickers answer with these paths. */
async function answerPickers(paths: string[]): Promise<void> {
  await l.app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths })) as typeof dialog.showOpenDialog
  }, paths)
}

async function createProject(name: string): Promise<{ id: string; folder: string }> {
  const p = await l.page.evaluate((n) => window.gallery.invoke('projects.create', { name: n }), name)
  await expect(l.page.getByRole('article', { name, exact: true })).toBeVisible()
  return { id: p.id, folder: join(libraryRoot, p.folder) }
}

test.beforeEach(async () => {
  parent = mkdtempSync(join(tmpdir(), 'gallerylab-imp-'))
  libraryRoot = join(parent, 'galleryLAB')
  sources = join(parent, 'sources')
  mkdirSync(sources)
  l = await launch({ env: { GALLERYLAB_DEFAULT_LIBRARY: libraryRoot } })
  await l.page.getByRole('button', { name: 'Use this folder' }).click()
  await expect(l.page.getByText('Create a project, then drop photos or folders anywhere in the window.')).toBeVisible()
})

test.afterEach(async () => {
  await l.cleanup()
  rmSync(parent, { recursive: true, force: true })
})

test('a project opens from its card, invites a drop, and Escape goes back', async () => {
  const { page } = l
  await createProject('Coastline')
  const card = page.getByRole('article', { name: 'Coastline', exact: true })
  await expect(card).toContainText('No photos yet')

  await card.focus()
  await card.press('Enter')
  await expect(page.getByRole('heading', { name: 'Coastline', level: 1 })).toBeVisible()
  await expect(page.getByText('Drop photos or folders anywhere in the window.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add photos' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add folder' })).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible()
  await expect(card).toBeFocused()

  // The Library button goes back too.
  await card.click()
  await expect(page.getByRole('heading', { name: 'Coastline', level: 1 })).toBeVisible()
  await page.getByRole('button', { name: 'Library' }).click()
  await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible()
})

test('a single click on a card title opens the project; a double-click renames', async () => {
  const { page } = l
  await createProject('Harbour')
  const title = page.getByRole('heading', { name: 'Harbour' })
  await title.dblclick()
  const input = page.getByRole('textbox', { name: 'Project name' })
  await expect(input).toBeFocused()
  await input.press('Escape')
  // Still on the Library: the double-click did not open the project.
  await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible()

  await title.click()
  await expect(page.getByRole('heading', { name: 'Harbour', level: 1 })).toBeVisible()
})

test('adding a folder imports its photos, shows them in the contact sheet and lists the issues', async () => {
  const { page } = l
  await makeSources()
  const project = await createProject('Trip')
  await page.getByRole('article', { name: 'Trip', exact: true }).click()
  await expect(page.getByText('Drop photos or folders anywhere in the window.')).toBeVisible()

  await answerPickers([join(sources, 'Trip')])
  await page.getByRole('button', { name: 'Add folder' }).click()

  // 11 new photos (10 JPEGs and the PNG), one duplicate skipped, two files that aren't photos.
  await expect(page.getByText('11 photos imported.')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('1 duplicate skipped')).toBeVisible()
  const sheet = page.getByRole('region', { name: 'Photos in this project' })
  await expect(sheet.locator('img.contact-thumb[data-loaded]')).toHaveCount(11, { timeout: 30_000 })
  await expect(sheet.getByRole('img', { name: 'IMG_1009.jpg' })).toBeVisible()

  // Photos are fitted whole: the portrait tile is taller than it is wide.
  const box = await sheet.getByRole('img', { name: 'IMG_1009.jpg' }).boundingBox()
  expect(box && box.height > box.width).toBe(true)

  const issues = page.getByRole('complementary', { name: 'Import' })
  await expect(issues.getByText('broken.jpg')).toBeVisible()
  await expect(issues.getByText('notes.txt')).toBeVisible()
  // Duplicates are summed up, not listed.
  await expect(issues.getByText('IMG_1000 copy.jpg')).toHaveCount(0)

  // Originals are copied keeping their subfolders; derivatives are made.
  expect(existsSync(join(project.folder, 'originals', 'Trip', 'Day 1', 'IMG_1000.jpg'))).toBe(true)
  expect(existsSync(join(project.folder, 'originals', 'Trip', 'Day 2', 'IMG_1009.jpg'))).toBe(true)
  const thumbs = readdirSync(join(project.folder, '.gallery', 'derivatives', 'thumb-512'))
  expect(thumbs.filter((f) => f.endsWith('.webp'))).toHaveLength(11)

  // The Library card shows the count; reopening lists the same photos from the index.
  await page.keyboard.press('Escape')
  const card = page.getByRole('article', { name: 'Trip', exact: true })
  await expect(card).toContainText('11 photos')
  await card.click()
  await expect(sheet.locator('img.contact-thumb[data-loaded]')).toHaveCount(11, { timeout: 15_000 })
})

test('a folder with a photo and a video imports both; the video tile shows its length under the poster', async () => {
  const { page } = l
  const dir = join(sources, 'Weekend')
  mkdirSync(dir)
  await photo(join(dir, 'IMG_2000.jpg'), 20)
  writeFileSync(join(dir, 'MVI_2001.mp4'), await video({ width: 640, height: 360, seconds: 134, fps: 5 }))
  const project = await createProject('Weekend')
  await page.getByRole('article', { name: 'Weekend', exact: true }).click()

  await answerPickers([dir])
  await page.getByRole('button', { name: 'Add folder' }).click()
  await expect(page.getByText('1 photo and 1 video imported.')).toBeVisible({ timeout: 60_000 })

  const sheet = page.getByRole('region', { name: 'Photos in this project' })
  await expect(sheet.locator('img.contact-thumb[data-loaded]')).toHaveCount(2, { timeout: 30_000 })
  const tile = sheet.locator('.contact-cell[data-video]')
  await expect(tile).toHaveCount(1)
  await expect(tile.getByRole('img', { name: 'MVI_2001.mp4' })).toBeVisible()
  await expect(tile.locator('.contact-duration')).toHaveText('2:14')
  // The length sits below the poster, not over it.
  const poster = await tile.getByRole('img', { name: 'MVI_2001.mp4' }).boundingBox()
  const label = await tile.locator('.contact-duration').boundingBox()
  expect(poster && label && label.y >= poster.y + poster.height).toBe(true)
  // Photo tiles have no label.
  await expect(sheet.locator('.contact-cell:not([data-video]) .contact-duration')).toHaveCount(0)

  expect(existsSync(join(project.folder, 'originals', 'Weekend', 'MVI_2001.mp4'))).toBe(true)
  const thumbs = readdirSync(join(project.folder, '.gallery', 'derivatives', 'thumb-512'))
  expect(thumbs.filter((f) => f.endsWith('.webp'))).toHaveLength(2)

  await page.keyboard.press('Escape')
  await expect(page.getByRole('article', { name: 'Weekend', exact: true })).toContainText('2 photos')
})

test('adding files with the picker imports them and a second add of the same files skips them', async () => {
  const { page } = l
  mkdirSync(join(sources, 'picked'))
  const files = [0, 1, 2].map((i) => join(sources, 'picked', `P${i}.jpg`))
  for (const [i, f] of files.entries()) await photo(f, 40 + i)
  await createProject('Picked')
  await page.getByRole('article', { name: 'Picked', exact: true }).click()

  await answerPickers(files)
  await page.getByRole('button', { name: 'Add photos' }).click()
  await expect(page.getByText('3 photos imported.')).toBeVisible({ timeout: 30_000 })

  await page.getByRole('button', { name: 'Add photos' }).click()
  await expect(page.getByText('No new photos imported.')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('3 duplicates skipped')).toBeVisible()
})

test('a drag over the project screen shows the drop outline; a drop outside a project says what to do', async () => {
  const { page } = l
  await createProject('Dunes')

  // On the Library, away from any card.
  await page.evaluate(() => {
    const dt = new DataTransfer()
    dt.items.add(new File(['x'], 'photo.jpg', { type: 'image/jpeg' }))
    document.body.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })
  await expect(page.getByText('Open a project, then drop photos or folders into it.')).toBeVisible()

  await page.getByRole('article', { name: 'Dunes', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Dunes', level: 1 })).toBeVisible()
  await page.evaluate(() => {
    const dt = new DataTransfer()
    dt.items.add(new File(['x'], 'photo.jpg', { type: 'image/jpeg' }))
    document.body.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })
  await expect(page.locator('.drop-overlay')).toBeVisible()
  await expect(page.getByText('Drop to import into Dunes')).toBeVisible()
  // The overlay goes once the drag stops.
  await expect(page.locator('.drop-overlay')).toHaveCount(0, { timeout: 2000 })

  // A dropped item that isn't a file on disk (synthetic here) is explained, not ignored.
  await page.evaluate(() => {
    const dt = new DataTransfer()
    dt.items.add(new File(['x'], 'photo.jpg', { type: 'image/jpeg' }))
    document.body.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })
  await expect(page.getByText('Those items aren’t files on this computer.', { exact: false })).toBeVisible()
})

test('import can be paused, resumed and shows progress on the Library card', async () => {
  const { page } = l
  mkdirSync(join(sources, 'many'))
  // Large enough that the import takes a moment.
  for (let i = 0; i < 60; i++) await photo(join(sources, 'many', `M${i}.jpg`), 100 + i, 2400, 1600)
  await createProject('Many')
  await page.getByRole('article', { name: 'Many', exact: true }).click()
  await answerPickers([join(sources, 'many')])
  await page.getByRole('button', { name: 'Add folder' }).click()

  const panel = page.getByRole('complementary', { name: 'Import' })
  await panel.getByRole('button', { name: 'Pause' }).click({ timeout: 10_000 })
  await expect(panel.getByText(/^Paused at /)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('article', { name: 'Many', exact: true })).toContainText('Import paused at')

  await page.getByRole('article', { name: 'Many', exact: true }).click()
  await panel.getByRole('button', { name: 'Resume' }).click()
  await expect(panel.getByText('60 photos imported.')).toBeVisible({ timeout: 60_000 })
})
