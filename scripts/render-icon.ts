// Render build/icon.svg to build/icon.png (512 px) with the bundled Chromium.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

async function run() {
  const svg = readFileSync(resolve(__dirname, '../build/icon.svg'), 'utf8')
  const browser = await chromium.launch(
    process.env['PW_CHROMIUM'] ? { executablePath: process.env['PW_CHROMIUM'] } : {}
  )
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } })
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', '<svg width="512" height="512" ')}</body></html>`
  )
  await page.screenshot({ path: resolve(__dirname, '../build/icon.png'), omitBackground: true })
  await browser.close()
}
run()
