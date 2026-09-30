/**
 * Versioned-document migration. `migrations[n]` upgrades a document from
 * version n to n + 1. Documents newer than the app are refused rather than
 * silently downgraded.
 */
export type Migration = (doc: Record<string, unknown>) => Record<string, unknown>

export class SchemaVersionError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number
  ) {
    super(`Written by a newer galleryLAB (schema ${found}; this version reads up to ${supported}).`)
  }
}

export function migrate(
  input: unknown,
  current: number,
  migrations: Record<number, Migration> = {}
): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('Expected a JSON object')
  }
  let doc = { ...(input as Record<string, unknown>) }
  let version = typeof doc.schemaVersion === 'number' ? doc.schemaVersion : 0
  if (version > current) throw new SchemaVersionError(version, current)
  while (version < current) {
    const step = migrations[version]
    if (!step) throw new Error(`No migration from schema ${version}`)
    doc = step(doc)
    version += 1
    doc.schemaVersion = version
  }
  return doc
}
