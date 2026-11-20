import { z } from "zod";
import { jmapScanStepSchema } from "./jmap-scan";
import { jmapStateSchema } from "./jmap-sync-state";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const utc = z.iso.datetime();
const scanSchema = z
  .object({
    reason: z.enum(["initial", "reconciliation"]),
    startedAt: utc,
    step: jmapScanStepSchema,
    pages: count,
    restarts: count,
    stalledAt: utc.nullable(),
  })
  .strict();
/** Only the current version decodes: no stored row predates it, so no older version is upgraded. */
export const jmapSyncStateSchema = z
  .object({
    version: z.literal(2),
    emailState: jmapStateSchema.nullable(),
    mailboxState: jmapStateSchema.nullable(),
    scan: scanSchema.nullable(),
  })
  .strict()
  // A scan always starts from both states, and the deltas keep both while it runs.
  .refine((state) => state.scan === null || (state.emailState !== null && state.mailboxState !== null));
export type JmapSyncState = z.infer<typeof jmapSyncStateSchema>;
export type JmapAccountScan = NonNullable<JmapSyncState["scan"]>;

export class JmapSyncStateError extends Error {
  readonly code = "JMAP_SYNC_STATE_UNSUPPORTED";
  constructor() {
    super("JMAP_SYNC_STATE_UNSUPPORTED");
    this.name = "JmapSyncStateError";
  }
}

/** SQL NULL means uninitialized; JSON text, older versions and unknown shapes are not decoded. */
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
