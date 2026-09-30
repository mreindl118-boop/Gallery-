// Write latest-portable.json (the portable build's update feed) for a built portable exe.
// Usage: node scripts/portable-feed.mjs <path-to-portable.exe> <out-dir>
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const [exe, outDir] = process.argv.slice(2)
if (!exe || !outDir) {
  console.error('Usage: node scripts/portable-feed.mjs <portable.exe> <out-dir>')
  process.exit(2)
}
const version = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version
const hash = createHash('sha512')
for await (const chunk of createReadStream(exe)) hash.update(chunk)
const feed = {
  version,
  file: basename(exe),
  size: statSync(exe).size,
  sha512: hash.digest('base64'),
  releaseDate: new Date().toISOString()
}
writeFileSync(join(outDir, 'latest-portable.json'), `${JSON.stringify(feed, null, 2)}\n`)
console.log(`latest-portable.json: ${feed.file} ${feed.version} (${feed.size} bytes)`)
