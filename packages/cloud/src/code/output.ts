import { z } from "zod";
import { AI_LIVE_SNAPSHOT_INTERVAL_MS } from "../ai/live-interval";
import { LIVE_LIMITS } from "../events/live-limits";

/** Reuse the AI stream's one-second bundling cadence; no separate output throughput policy. */
export const CODE_OUTPUT_INTERVAL_MS = AI_LIVE_SNAPSHOT_INTERVAL_MS;
export const CODE_OUTPUT_OPERATION = "runtime.output";
const count = z.number().int().nonnegative().safe();
// One local definition keeps repeated timestamp patterns within the existing
// capability-manifest budget without changing the accepted date-time format.
const outputAt = z.iso.datetime().meta({ id: "CodeOutputAt" });
const logMetadata = {
  kind: z.literal("log"),
  level: z.enum(["log", "info", "debug", "warn", "error"]),
  at: outputAt,
};
/** Step text fields share one existing live-frame budget, including the largest wire metadata.
 * Dividing the remaining bytes among the fields ensures a complete update can fit a frame.
 * The serialized complete step derives the lifetime handle count; no independent policy knob.
 */
export const CODE_OUTPUT_STEP_TEXT_FIELDS = ["label", "icon", "description", "message"] as const;
const stepMetadata = {
  kind: z.literal("step"),
  at: outputAt,
  status: z.enum(["pending", "running", "succeeded", "failed", "skipped"]),
  startedAt: outputAt.optional(),
  endedAt: outputAt.optional(),
};
const stepEnvelope = {
  kind: "step",
  id: Number.MAX_SAFE_INTEGER,
  at: "2030-01-02T00:00:00.000Z",
  label: "",
  icon: "",
  description: "",
  status: "succeeded",
  startedAt: "2030-01-02T00:00:00.000Z",
  endedAt: "2030-01-02T00:00:00.000Z",
  message: "",
};
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
// Reserve the canonical map form, including the largest safe generation/ID,
// named secret parts, optional fields and automatic completion. Short fields may
// expand to one maximum-size secret marker without consuming another handle's slot.
const canonicalId = `${Number.MAX_SAFE_INTEGER}:step:${Number.MAX_SAFE_INTEGER}`;
// The part schema permits one initial name character plus 63 following ones;
// the icon schema below permits at most 64 ASCII characters.
const secretPart = { type: "secret", name: "S".repeat(64) };
const canonicalStep = {
  ...stepEnvelope,
  id: canonicalId,
  label: [secretPart],
  icon: "a".repeat(64),
  description: [secretPart],
  message: [secretPart],
  reason: "run_ended",
};
const stepMetadataBytes = bytes(canonicalStep) + bytes(canonicalId) + 2;
const stepTextReserveBytes = bytes(secretPart) - bytes({ type: "text", text: "" });
/** Canonical event overhead uses the safe-integer transport widths, not observed counters. */
export function codeOutputStepsBudget(runId: string, generation: number, budget: number) {
  return Math.min(
    budget,
    LIVE_LIMITS.frameBytes -
      bytes({
        generation,
        entries: [],
        seq: Number.MAX_SAFE_INTEGER,
        droppedLines: Number.MAX_SAFE_INTEGER,
        droppedBytes: Number.MAX_SAFE_INTEGER,
        type: "code.output",
        runId,
        budget: Number.MAX_SAFE_INTEGER,
      }) +
      bytes([]),
  );
}
export const CODE_OUTPUT_STEP_LIMITS = Object.freeze({
  count: Math.floor(
    (codeOutputStepsBudget("00000000-0000-4000-8000-000000000000", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) - bytes({})) /
      stepMetadataBytes,
  ),
  metadataBytes: stepMetadataBytes,
  textReserveBytes: stepTextReserveBytes,
  textBytes: Math.floor(
    (LIVE_LIMITS.frameBytes -
      bytes({
        seq: Number.MAX_SAFE_INTEGER,
        entries: [stepEnvelope],
        droppedLines: Number.MAX_SAFE_INTEGER,
        droppedBytes: Number.MAX_SAFE_INTEGER,
      })) /
      CODE_OUTPUT_STEP_TEXT_FIELDS.length,
  ),
});
/** Same reservation in the isolate and Core. Repeated immutable fields cost once;
 * redacted parts are bounded to this reservation before another step is admitted.
 */
export function codeOutputStepBytes(entry: Partial<Record<(typeof CODE_OUTPUT_STEP_TEXT_FIELDS)[number], string>>) {
  return (
    CODE_OUTPUT_STEP_LIMITS.metadataBytes +
    CODE_OUTPUT_STEP_TEXT_FIELDS.reduce(
      (size, field) => size + Math.max(0, bytes(entry[field] ?? "") - bytes("") - CODE_OUTPUT_STEP_LIMITS.textReserveBytes),
      0,
    )
  );
}
const stepText = z.string().refine((value) => bytes(value) <= CODE_OUTPUT_STEP_LIMITS.textBytes);
export const CodeOutputLogInputSchema = z.object({ ...logMetadata, text: z.string() }).strict();
export const CodeOutputStepInputSchema = z
  .object({
    ...stepMetadata,
    id: count.positive().max(CODE_OUTPUT_STEP_LIMITS.count),
    label: stepText,
    icon: stepText.optional(),
    description: stepText.optional(),
    message: stepText.optional(),
  })
  .strict();
export const CodeOutputBatchSchema = z
  .object({
    seq: count.positive(),
    entries: z.array(z.discriminatedUnion("kind", [CodeOutputLogInputSchema, CodeOutputStepInputSchema])),
    droppedLines: count,
    droppedBytes: count,
  })
  .strict()
  .refine((batch) => bytes(batch) <= LIVE_LIMITS.frameBytes);
export type CodeOutputBatch = z.infer<typeof CodeOutputBatchSchema>;
export const CodeOutputPartSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }).strict(),
    z.object({ type: z.literal("secret"), name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/) }).strict(),
  ])
  // Reuse one local JSON Schema definition for log and step text fields, rather
  // than inlining their identical unions into the bounded capability manifest.
  .meta({ id: "CodeOutputPart" });
export type CodeOutputText = z.infer<typeof CodeOutputPartSchema>[];
export const CodeOutputStepEntrySchema = z
  .object({
    ...stepMetadata,
    id: z.string().min(1),
    label: z.array(CodeOutputPartSchema),
    icon: z
      .string()
      .max(64)
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    description: z.array(CodeOutputPartSchema).optional(),
    message: z.array(CodeOutputPartSchema).optional(),
    reason: z.string().optional(),
  })
  .strict();
export const CodeOutputKnownEntrySchema = z.discriminatedUnion("kind", [
  z.object({ ...logMetadata, id: z.string().min(1), text: z.array(CodeOutputPartSchema) }).strict(),
  CodeOutputStepEntrySchema,
]);
export type CodeOutputKnownEntry = z.infer<typeof CodeOutputKnownEntrySchema>;
const knownKinds = new Set<string>(CodeOutputKnownEntrySchema.options.map((entry) => entry.shape.kind.value));
/** Future entry kinds remain opaque data: retain them for identical window accounting,
 * but never render their fields as a known kind. Known malformed entries still fail.
 */
export const CodeOutputEntrySchema = z.union([
  CodeOutputKnownEntrySchema,
  z.object({ kind: z.string().refine((kind) => !knownKinds.has(kind)) }).passthrough(),
]);
export type CodeOutputEntry = z.infer<typeof CodeOutputEntrySchema>;
export function isCodeOutputLogEntry(entry: CodeOutputEntry): entry is Extract<CodeOutputKnownEntry, { kind: "log" }> {
  return entry.kind === "log";
}
export function isCodeOutputStepEntry(entry: CodeOutputEntry): entry is Extract<CodeOutputKnownEntry, { kind: "step" }> {
  return entry.kind === "step";
}
/** An entry counts once regardless of how many fields a step carries. */
export const codeOutputEntryLines = (entry: CodeOutputBatch["entries"][number]) =>
  entry.kind === "log" ? entry.text.split(/\r\n|\n|\r/).length : 1;
export const CodeOutputWindowSchema = z
  .object({
    generation: count,
    seq: count,
    entries: z.array(CodeOutputEntrySchema),
    droppedLines: count,
    droppedBytes: count,
  })
  .strict();
export type CodeOutputWindow = z.infer<typeof CodeOutputWindowSchema>;
export const emptyCodeOutput = (generation = 0): CodeOutputWindow => ({
  generation,
  seq: 0,
  entries: [],
  droppedLines: 0,
  droppedBytes: 0,
});
export const CodeOutputEventSchema = CodeOutputWindowSchema.omit({ entries: true })
  .extend({
    type: z.literal("code.output"),
    runId: z.uuid(),
    /** Accepted entries of this batch, before applying the shared tail window. */
    entries: z.array(CodeOutputEntrySchema),
    budget: count.positive(),
  })
  .strict();
export type CodeOutputEvent = z.infer<typeof CodeOutputEventSchema>;
const sum = (a: number, b: number) => Math.min(Number.MAX_SAFE_INTEGER, a + b);
/** Same tail window on Core, replay and browser, including opaque future kinds. Counters are fixed-size metadata. */
export function appendCodeOutput(
  window: CodeOutputWindow,
  entries: readonly CodeOutputEntry[],
  budget: number,
  dropped: { lines: number; bytes: number } = { lines: 0, bytes: 0 },
): CodeOutputWindow {
  const merged = [...window.entries];
  const positions = new Map(merged.flatMap((entry, index) => (isCodeOutputStepEntry(entry) ? [[entry.id, index] as const] : [])));
  for (const entry of entries) {
    const position = isCodeOutputStepEntry(entry) ? positions.get(entry.id) : undefined;
    if (position === undefined) {
      if (isCodeOutputStepEntry(entry)) positions.set(entry.id, merged.length);
      merged.push(entry);
    } else merged[position] = entry;
  }
  const next = {
    ...window,
    entries: merged,
    droppedLines: sum(window.droppedLines, dropped.lines),
    droppedBytes: sum(window.droppedBytes, dropped.bytes),
  };
  const sizes = next.entries.map(bytes);
  let size = bytes([]) + sizes.reduce((total, size) => total + size, 0) + Math.max(0, sizes.length - 1);
  const removed = new Set<number>();
  // Preserve step creation order: logs and opaque entries yield first. Core and
  // the runner bound retained step metadata with the existing output budget.
  for (const steps of [false, true]) {
    for (let index = 0; index < sizes.length && size > budget; index++) {
      if (isCodeOutputStepEntry(next.entries[index]!) !== steps) continue;
      const entryBytes = sizes[index]!;
      size -= entryBytes + (sizes.length - removed.size > 1 ? 1 : 0);
      next.droppedLines = sum(next.droppedLines, 1);
      next.droppedBytes = sum(next.droppedBytes, entryBytes);
      removed.add(index);
    }
  }
  next.entries = next.entries.filter((_, index) => !removed.has(index));
  return next;
}
/** Replayed and out-of-order events never duplicate output or regress a newer attempt. */
export function applyCodeOutputEvent(window: CodeOutputWindow, event: CodeOutputEvent): CodeOutputWindow {
  if (event.generation < window.generation || (event.generation === window.generation && event.seq <= window.seq)) return window;
  const base = event.generation === window.generation ? window : emptyCodeOutput(event.generation);
  const next = appendCodeOutput({ ...base, seq: event.seq }, event.entries, event.budget);
  return {
    ...next,
    droppedLines: Math.max(next.droppedLines, event.droppedLines),
    droppedBytes: Math.max(next.droppedBytes, event.droppedBytes),
  };
}

/** ANSI CSI/OSC/DCS sequences, controls and direction/format marks are never rendered. Newlines split lines upstream. */
export function cleanCodeOutput(text: string): string {
  return text
    .replace(
      /(?:(?:\u001b\]|\u009d)[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c|$))|(?:(?:\u001b[P^_X]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\u001b\\|\u009c|$))|(?:(?:\u001b\[|\u009b)[0-?]*[ -/]*(?:[@-~]|$))|(?:\u001b[ -/]*[0-~])/g,
      "",
    )
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "");
}
/** Core supplies already-redacted text. Markers become data, never HTML or an unescaped secret value. */
export function codeOutputParts(text: string): CodeOutputText {
  const parts: CodeOutputText = [];
  let offset = 0;
  for (const match of text.matchAll(/\[secret:([A-Za-z_][A-Za-z0-9_]{0,63})\]/g)) {
    if (match.index > offset) parts.push({ type: "text", text: text.slice(offset, match.index) });
    parts.push({ type: "secret", name: match[1]! });
    offset = match.index + match[0].length;
  }
  if (offset < text.length) parts.push({ type: "text", text: text.slice(offset) });
  return parts;
}
