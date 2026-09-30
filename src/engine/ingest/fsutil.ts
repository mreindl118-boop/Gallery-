import { constants, createReadStream, promises as fs } from 'node:fs'
import { createXXHash128 } from 'hash-wasm'

/** Small filesystem helpers for ingest: streaming hash, temp-then-rename writes, free space. */

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES'])

/** On Windows a rename can fail for a moment while an indexer or antivirus holds the file; retry briefly. */
export async function renameWithRetry(from: string, to: string): Promise<void> {
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

export async function writeFileAtomic(file: string, data: Uint8Array): Promise<void> {
  const tmp = `${file}.part`
  try {
    await fs.writeFile(tmp, data)
    await renameWithRetry(tmp, file)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

/** Streaming content hash (xxHash128, hex). */
export async function hashFile(file: string): Promise<string> {
  const hasher = await createXXHash128()
  hasher.init()
  const stream = createReadStream(file, { highWaterMark: 1 << 20 })
  for await (const chunk of stream) hasher.update(chunk as Buffer)
  return hasher.digest('hex')
}

/** Reads the first `n` bytes of a file (fewer when it is shorter). */
export async function readHead(file: string, n: number): Promise<Buffer> {
  const handle = await fs.open(file, 'r')
  try {
    const buf = Buffer.alloc(n)
    const { bytesRead } = await handle.read(buf, 0, n, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * Copies `from` to `tmp` and renames it to `to`. The rename target was checked
 * to be free just before; the copy never touches the source.
 */
export async function copyFileAtomic(from: string, tmp: string, to: string, expectedBytes: number): Promise<void> {
  try {
    await fs.copyFile(from, tmp)
    const [st, src] = await Promise.all([fs.stat(tmp), fs.stat(from)])
    if (st.size !== expectedBytes) throw Object.assign(new Error('The copy is incomplete.'), { code: 'EIO' })
    await fs.utimes(tmp, src.atime, src.mtime).catch(() => undefined)
    // Never replace a file that appeared meanwhile: fail instead and let the caller pick another name.
    await fs.access(to, constants.F_OK).then(
      () => {
        throw Object.assign(new Error('Target exists'), { code: 'EEXIST' })
      },
      () => undefined
    )
    await renameWithRetry(tmp, to)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

/** Free bytes available to this user on the volume holding `dir`. */
export async function freeBytes(dir: string): Promise<number> {
  const s = await fs.statfs(dir)
  return Number(s.bavail) * Number(s.bsize)
}
