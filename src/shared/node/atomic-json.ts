import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, basename, join } from 'node:path'
import type { z } from 'zod'
import { migrate, type Migration } from '../migrate'

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES'])

/**
 * Write JSON atomically: temp file in the same folder → fsync → rename.
 * On Windows a rename over a file that an indexer or antivirus holds open
 * fails with EPERM/EBUSY for a moment, so renames retry with backoff.
 */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const dir = dirname(file)
  await fs.mkdir(dir, { recursive: true })
  const tmp = join(dir, `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`)
  const body = `${JSON.stringify(data, null, 2)}\n`
  const handle = await fs.open(tmp, 'w')
  try {
    await handle.writeFile(body, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await renameWithRetry(tmp, file)
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  let delay = 20
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (!RETRYABLE.has(code) || attempt >= 6) throw err
      await new Promise((r) => setTimeout(r, delay))
      delay *= 2
    }
  }
}

/**
 * Read a versioned JSON document, migrate it to the current schema and
 * validate it. Returns null when the file does not exist.
 */
export async function readJsonVersioned<S extends z.ZodType>(
  file: string,
  schema: S,
  current: number,
  migrations: Record<number, Migration> = {}
): Promise<z.output<S> | null> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const raw: unknown = JSON.parse(text.replace(/^\uFEFF/, ''))
  return schema.parse(migrate(raw, current, migrations))
}
