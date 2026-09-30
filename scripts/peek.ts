// Quick manual look: launch, screenshot, print console. `npx tsx scripts/peek.ts out.png`
import { launch } from '../e2e/harness'

async function run() {
  const out = process.argv[2] ?? 'peek.png'
  const l = await launch()
  l.page.on('console', (m) => console.log('[console]', m.type(), m.text()))
  l.page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await l.page.waitForTimeout(1500)
  await l.page.screenshot({ path: out })
  console.log(await l.page.evaluate(() => document.body.innerText))
  await l.cleanup()
}
run().catch((e) => {
  console.error(e)
  process.exit(1)
})
