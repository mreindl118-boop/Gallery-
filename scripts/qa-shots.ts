/**
 * npm run qa:shots — render every screen that exists into qa/shots/<date>/,
 * in both themes. Grows with each milestone (archetype stations from M4).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Page } from 'playwright'
import { launch } from '../e2e/harness'

const stamp = new Date().toISOString().slice(0, 10)
const outDir = resolve(__dirname, '..', 'qa', 'shots', stamp)
mkdirSync(outDir, { recursive: true })

const NAMES = [
  'Coastline',
  'Night shifts',
  'Kyoto, winter',
  'Salt flats',
  'A very long project name that keeps going for a while'
]

async function shot(page: Page, name: string) {
  await page.waitForTimeout(400) // let fonts and dialog motion settle
  await page.screenshot({ path: join(outDir, `${name}.png`) })
  console.log('shot', name)
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((t) => window.gallery.invoke('settings.setTheme', { theme: t }), theme)
  await page.waitForFunction((t) => document.documentElement.dataset['theme'] === t, theme)
}

async function run() {
  const libParent = mkdtempSync(join(tmpdir(), 'gallerylab-qa-'))
  const lib = join(libParent, 'galleryLAB')
  const l = await launch({ env: { GALLERYLAB_DEFAULT_LIBRARY: lib } })
  const { page } = l
  await page.setViewportSize({ width: 1440, height: 900 })
  try {
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme)
      await shot(page, `first-run-${theme}`)
    }
    await setTheme(page, 'light')
    await page.getByRole('button', { name: 'Use this folder' }).click()
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme)
      await shot(page, `library-empty-${theme}`)
    }
    for (const name of NAMES) await page.evaluate((n) => window.gallery.invoke('projects.create', { name: n }), name)
    await page.waitForTimeout(300)
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme)
      await shot(page, `library-${theme}`)
      await page.getByRole('article').first().focus()
      await page.keyboard.press('ArrowRight')
      await shot(page, `library-focus-${theme}`)
      await page.keyboard.press('F2')
      await shot(page, `library-rename-${theme}`)
      await page.keyboard.press('Escape')
      await page.getByRole('article').nth(1).click({ button: 'right' })
      await shot(page, `library-menu-${theme}`)
      await page.keyboard.press('Escape')
      await page.getByRole('article').nth(1).press('Delete')
      await shot(page, `library-confirm-delete-${theme}`)
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'Settings' }).click()
      await shot(page, `settings-${theme}`)
      await page.keyboard.press('Escape')
    }
    await page.setViewportSize({ width: 1024, height: 700 })
    await setTheme(page, 'light')
    await shot(page, 'library-small-light')
  } finally {
    await l.cleanup()
    rmSync(libParent, { recursive: true, force: true })
  }
  console.log(`Shots in ${outDir}`)
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
