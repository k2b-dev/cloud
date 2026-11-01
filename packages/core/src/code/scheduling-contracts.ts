import { z } from "zod";
import { CodeIdSchema } from "./contracts";

/** Manual start and explicit rerun both create one attempt, pinned to the currently active version.
 * Keys are permanent per Code, including after run-detail retention. A repeated matching request returns the original ID; a changed request conflicts.
 */
export const CodeStartRequestSchema = z
  .object({
    codeId: CodeIdSchema,
    entrypoint: z.string().min(1).max(256).describe("Declared entrypoint name of the active version."),
    idempotencyKey: z
      .string()
      .min(1)
      .max(96)
      .refine((value) => new TextEncoder().encode(value).byteLength <= 96, "Key exceeds 96 UTF-8 bytes")
      .describe("Request key; reuse it to recover the receipt, use a new key to run again."),
    input: z.json().default(null).describe("JSON input passed to the entrypoint."),
  })
  .strict();
export type CodeStartRequest = z.input<typeof CodeStartRequestSchema>;
/** Duplicate requests never publish a second run, even across Core replicas. */
export type CodeStartResult = { runId: string; duplicate: boolean };
/** Public capability boundary. The framework's idempotency key supplies the permanent start receipt. */
export const codeSchedulingContracts = {
  start: {
    input: CodeStartRequestSchema.omit({ idempotencyKey: true }),
    data: z.object({ runId: z.uuid(), duplicate: z.boolean() }).strict(),
  },
} as const;
/** Snapshot of administrator admission budgets; retries retain the original deadline and call budget. */
export type CodeRunLimits = { perCode: number; perOwner: number; wallMs: number; attempts: number };
/** Durable tick identity is Code + named app.schedule export + slot, never a runner. versionId checks admission. */
export type CodeScheduleTick = { codeId: string; versionId: string; entrypoint: string; slot: Date };
/** Payload-free, installation-wide read model for Administration › Code (C22).
 * instances/freeSlots include only fresh signed polls. instance pages use UUID cursors, at most 50 rows.
 */
export type CodeRunnerMetrics = {
  queued: number;
  running: number;
  oldestWaitingMs: number;
  instances: number;
  freeSlots: number;
  runners: Array<{ instanceId: string; freeSlots: number; lastSeenAt: string }>;
  nextCursor: string | null;
};
/** Stable outcomes are translated at the UI, including the skipped tick and explicit rerun recovery. */
export const CODE_RUN_OUTCOMES = {
  previousRunning: "previous_schedule_running",
  lost: "lease_lost",
  inactive: "code_not_active",
  admissionRefused: "code_admission_refused",
  mandateMismatch: "code_mandate_mismatch",
  retryExhausted: "retry_exhausted",
  succeeded: "succeeded",
  failed: "failed",
  wallClockLimit: "wall_clock_limit",
  memoryLimit: "memory_limit",
  stalled: "stalled",
} as const;
/** Transport leases last three heartbeat periods; independent of replica count. */
export const CODE_RUN_HEARTBEAT_MS = 5_000;
export const CODE_RUN_LEASE_MS = 3 * CODE_RUN_HEARTBEAT_MS;

/** Matches the broker tick retention; older ticks are never admitted after their receipt expires. */
export const CODE_SCHEDULE_TICK_RETENTION_MS = 7 * 86_400_000;
