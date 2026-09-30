import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { folderNameFor, MAX_FOLDER_LENGTH, uniqueFolderName } from '@shared/names'

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i

describe('folderNameFor', () => {
  it('keeps ordinary names', () => {
    expect(folderNameFor('Kyoto, winter')).toBe('Kyoto, winter')
    expect(folderNameFor('Café – Łódź 東京')).toBe('Café – Łódź 東京')
  })

  it('replaces characters Windows forbids and trims trailing dots and spaces', () => {
    expect(folderNameFor('Low tide: 1/2')).toBe('Low tide 1 2')
    expect(folderNameFor('What? <Now>*')).toBe('What Now')
    expect(folderNameFor('Ending...  ')).toBe('Ending')
    expect(folderNameFor('.hidden')).toBe('hidden')
  })

  it('never produces reserved device names or empty names', () => {
    expect(folderNameFor('CON')).toBe('CON project')
    expect(folderNameFor('nul.txt')).toBe('nul.txt project')
    expect(folderNameFor('///')).toBe('Untitled project')
  })

  it('always yields a valid Windows folder name (property)', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 300 }), (name) => {
        const f = folderNameFor(name)
        expect(f.length).toBeGreaterThan(0)
        expect(Array.from(f).length).toBeLessThanOrEqual(MAX_FOLDER_LENGTH + ' project'.length)
        // eslint-disable-next-line no-control-regex
        expect(f).not.toMatch(/[<>:"/\\|?*\u0000-\u001f]/)
        expect(f).not.toMatch(/[. ]$/)
        expect(f).not.toMatch(/^[. ]/)
        expect(RESERVED.test(f)).toBe(false)
      }),
      { numRuns: 2000 }
    )
  })
})

describe('uniqueFolderName', () => {
  it('numbers collisions case-insensitively', () => {
    expect(uniqueFolderName('Coastline', [])).toBe('Coastline')
    expect(uniqueFolderName('coastline', ['Coastline'])).toBe('coastline 2')
    expect(uniqueFolderName('A', ['a', 'A 2', 'a 3'])).toBe('A 4')
  })

  it('does not collide with the folder being renamed', () => {
    expect(uniqueFolderName('coastline', ['Coastline'], 'Coastline')).toBe('coastline')
  })

  it('always returns a name not taken (property)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 90 }),
        fc.array(fc.string({ maxLength: 90 }), { maxLength: 30 }),
        (raw, taken) => {
          const base = folderNameFor(raw)
          const all = [...taken, base, `${base} 2`]
          const name = uniqueFolderName(base, all)
          expect(all.map((t) => t.toLowerCase())).not.toContain(name.toLowerCase())
          expect(Array.from(name).length).toBeLessThanOrEqual(MAX_FOLDER_LENGTH + ' project'.length)
        }
      ),
      { numRuns: 1000 }
    )
  })
})
