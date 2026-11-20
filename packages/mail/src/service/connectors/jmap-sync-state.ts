import { z } from "zod";

// Opaque, not an Id: 1,024 UTF-16 units allow up to 4 KiB of UTF-8 per token.
// This local metadata budget leaves ample room beyond Stalwart's short states
// without letting a provider grow persisted checkpoints without a bound.
export const jmapStateSchema = z.string().max(1_024);
export const jmapSyncStateSchema = z
  .object({
    version: z.literal(1),
    emailState: jmapStateSchema.nullable(),
    mailboxState: jmapStateSchema.nullable(),
    scan: z.null(),
  })
  .strict();
export type JmapSyncState = z.infer<typeof jmapSyncStateSchema>;

export class JmapSyncStateError extends Error {
  readonly code = "JMAP_SYNC_STATE_UNSUPPORTED";
  constructor() {
    super("JMAP_SYNC_STATE_UNSUPPORTED");
    this.name = "JmapSyncStateError";
  }
}

/** SQL NULL means uninitialized; JSON text and legacy objects are not decoded. */
export function readJmapSyncState(value: unknown): JmapSyncState | null {
  if (value === null) return null;
  const parsed = jmapSyncStateSchema.safeParse(value);
  if (!parsed.success) throw new JmapSyncStateError();
  return parsed.data;
}

/** Return a validated JSON object for the SQL client's jsonb serialization. */
export function serializeJmapSyncState(value: JmapSyncState): JmapSyncState {
  const parsed = jmapSyncStateSchema.safeParse(value);
  if (!parsed.success) throw new JmapSyncStateError();
  return parsed.data;
}
