import { z } from 'zod'

/** Messages between main and the engine utility process (parentPort). */
export const EngineRequest = z.object({
  kind: z.literal('request'),
  id: z.number().int(),
  method: z.string(),
  params: z.unknown()
})
export type EngineRequest = z.infer<typeof EngineRequest>

export const EngineMessage = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('response'),
    id: z.number().int(),
    ok: z.boolean(),
    value: z.unknown().optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional()
  }),
  z.object({ kind: z.literal('ready'), version: z.string() }),
  z.object({ kind: z.literal('log'), level: z.enum(['info', 'warn', 'error']), message: z.string() })
])
export type EngineMessage = z.infer<typeof EngineMessage>

/** Sent once per renderer connection, carrying the renderer's MessagePort. */
export const ENGINE_ATTACH_PORT = 'attach-port'
