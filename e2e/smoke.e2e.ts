import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import sharp from 'sharp'
import { video } from '../tests/fixtures/videos'
import { launch } from './harness'

// Launches whatever build the harness points at (dev output or a packaged
// executable via GALLERYLAB_EXECUTABLE) and checks the core loop works,
// including a real import so the packaged image library, SQLite and the
// unpacked ffmpeg/ffprobe binaries are exercised.
test('app launches, a project can be created and a photo and a video import', async () => {
  const base = mkdtempSync(join(tmpdir(), 'gallerylab-smoke-'))
  const lib = join(base, 'galleryLAB')
  const src = join(base, 'Photos')
  mkdirSync(src)
  await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 90, g: 120, b: 160 } } })
    .jpeg()
    .toFile(join(src, 'one.jpg'))
  writeFileSync(join(src, 'two.mp4'), await video({ seconds: 3 }))
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
    const p = (await l.page.evaluate(() => window.gallery.invoke('projects.list')))[0]!
    await l.page.evaluate((a) => window.gallery.invoke('import.add', a), { id: p.id, paths: [src] })
    await expect
      .poll(
        () => l.page.evaluate((id) => window.gallery.invoke('import.status', { id }).then((s) => s.progress), p.id),
        { timeout: 60_000 }
      )
      .toMatchObject({ state: 'done', imported: 2, importedVideos: 1, failed: 0 })
    const photos = await l.page.evaluate((id) => window.gallery.invoke('photos.list', { id }), p.id)
    expect(photos).toHaveLength(2)
    const clip = photos.find((x) => x.kind === 'video')!
    expect(clip).toMatchObject({ format: 'mp4', durationMs: 3000, width: 320, height: 240 })
    for (const ph of photos) {
      expect(ph.thumb).toBeTruthy()
      const status = await l.page.evaluate((u) => fetch(u).then((r) => r.status), `gallery://${p.id}/${ph.thumb}`)
      expect(status).toBe(200)
    }
  } finally {
    await l.cleanup()
    rmSync(base, { recursive: true, force: true })
  }
})
