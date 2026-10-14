import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readMetadata } from '../src/engine/ingest/metadata'
import { copyXmp } from '../src/engine/ingest/xmp'
import { jpegWithExif, writeFile } from './fixtures/images'
import { editedXmp } from './fixtures/xmp'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gl-xmp-'))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('XMP sidecar metadata', () => {
  it('reads editor metadata while preserving camera facts and an explicit zero rating', async () => {
    const photo = await writeFile(join(tmp, 'photo.jpg'), await jpegWithExif())
    await writeFile(join(tmp, 'photo.xmp'), editedXmp)
    expect(await readMetadata(photo)).toMatchObject({
      camera: 'Canon EOS R5',
      takenAt: '2024-05-01T10:20:30+09:00',
      rating: 0,
      title: 'Edited harbour',
      caption: 'A & B',
      keywords: ['edited', 'sea']
    })
  })
  it('prefers the full image name and accepts uppercase XMP extensions', async () => {
    const photo = await writeFile(join(tmp, 'photo.jpg'), await jpegWithExif())
    await writeFile(join(tmp, 'photo.xmp'), editedXmp)
    await writeFile(join(tmp, 'photo.jpg.XMP'), editedXmp.replace('Edited harbour', 'Specific photo'))
    expect((await readMetadata(photo)).title).toBe('Specific photo')
  })
  it('keeps embedded facts when a sidecar is missing, unreadable or malformed', async () => {
    const photo = await writeFile(join(tmp, 'photo.jpg'), await jpegWithExif())
    const embedded = await readMetadata(photo)
    await writeFile(join(tmp, 'photo.xmp'), 'not XML')
    expect(await readMetadata(photo)).toEqual(embedded)
    rmSync(join(tmp, 'photo.xmp'))
    symlinkSync(join(tmp, 'missing'), join(tmp, 'photo.xmp'))
    expect(await readMetadata(photo)).toEqual(embedded)
  })
  it('still reads a sidecar when the image has no readable embedded metadata', async () => {
    const photo = await writeFile(join(tmp, 'photo.jpg'), 'not an image')
    await writeFile(join(tmp, 'photo.xmp'), editedXmp)
    expect(await readMetadata(photo)).toMatchObject({ title: 'Edited harbour', camera: null, rating: 0 })
  })
  it('preserves each full image name and does not overwrite a previous sidecar on resume', async () => {
    const source = await writeFile(join(tmp, 'source.jpg'), await jpegWithExif())
    await writeFile(join(tmp, 'source.xmp'), editedXmp)
    const copy = await writeFile(join(tmp, 'copy.jpg'), await jpegWithExif())
    await copyXmp(source, copy)
    await writeFile(join(tmp, 'source.xmp'), editedXmp.replace('Edited harbour', 'Later edit'))
    await copyXmp(source, copy)
    expect((await readMetadata(copy)).title).toBe('Edited harbour')
  })
  it('does not let a sidecar change the orientation used for the imported pixels', async () => {
    const photo = await writeFile(join(tmp, 'photo.jpg'), await jpegWithExif())
    const before = await readMetadata(photo)
    await writeFile(
      join(tmp, 'photo.xmp'),
      editedXmp.replace(
        'xmp:Rating="0"',
        'xmlns:tiff="http://ns.adobe.com/tiff/1.0/" tiff:Orientation="8" xmp:Rating="0"'
      )
    )
    expect((await readMetadata(photo)).orientation).toBe(before.orientation)
  })
  it('decodes XML text once, preserves unknown entities and supports numeric Unicode', async () => {
    const photo = await writeFile(join(tmp, 'photo.jpg'), await jpegWithExif())
    await writeFile(
      join(tmp, 'photo.xmp'),
      editedXmp.replace('Edited harbour', '&lt;title&gt; &amp;lt; &#233; &#x1F30A; &unknown; &#xD800;')
    )
    expect((await readMetadata(photo)).title).toBe('<title> &lt; é 🌊 &unknown; &#xD800;')
  })
})
