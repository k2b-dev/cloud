import { z } from "zod";
import { AI_LIVE_SNAPSHOT_INTERVAL_MS } from "../ai/live-interval";
import { LIVE_LIMITS } from "../events/live-limits";

/** Reuse the AI stream's one-second bundling cadence; no separate output throughput policy. */
export const CODE_OUTPUT_INTERVAL_MS = AI_LIVE_SNAPSHOT_INTERVAL_MS;
export const CODE_OUTPUT_OPERATION = "runtime.output";
const count = z.number().int().nonnegative().safe();
const logMetadata = {
  kind: z.literal("log"),
  level: z.enum(["log", "info", "debug", "warn", "error"]),
  at: z.iso.datetime(),
};
export const CodeOutputBatchSchema = z
  .object({
    seq: count.positive(),
    entries: z.array(z.object({ ...logMetadata, text: z.string() }).strict()),
    droppedLines: count,
    droppedBytes: count,
  })
  .strict()
  .refine((batch) => new TextEncoder().encode(JSON.stringify(batch)).length <= LIVE_LIMITS.frameBytes);
export type CodeOutputBatch = z.infer<typeof CodeOutputBatchSchema>;
export const CodeOutputPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z.object({ type: z.literal("secret"), name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/) }).strict(),
]);
export const CodeOutputKnownEntrySchema = z.discriminatedUnion("kind", [
  z.object({ ...logMetadata, id: z.string().min(1), text: z.array(CodeOutputPartSchema) }).strict(),
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
export const emptyCodeOutput = (generation = 0): CodeOutputWindow => ({ generation, seq: 0, entries: [], droppedLines: 0, droppedBytes: 0 });
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
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const sum = (a: number, b: number) => Math.min(Number.MAX_SAFE_INTEGER, a + b);
/** Same tail window on Core, replay and browser, including opaque future kinds. Counters are fixed-size metadata. */
export function appendCodeOutput(
  window: CodeOutputWindow,
  entries: readonly CodeOutputEntry[],
  budget: number,
  dropped: { lines: number; bytes: number } = { lines: 0, bytes: 0 },
): CodeOutputWindow {
  const next = {
    ...window,
    entries: [...window.entries, ...entries],
    droppedLines: sum(window.droppedLines, dropped.lines),
    droppedBytes: sum(window.droppedBytes, dropped.bytes),
  };
  const sizes = next.entries.map(bytes);
  let size = bytes([]) + sizes.reduce((total, size) => total + size, 0) + Math.max(0, sizes.length - 1);
  let removed = 0;
  while (removed < sizes.length && size > budget) {
    const entryBytes = sizes[removed]!;
    size -= entryBytes + (removed + 1 < sizes.length ? 1 : 0);
    next.droppedLines = sum(next.droppedLines, 1);
    next.droppedBytes = sum(next.droppedBytes, entryBytes);
    removed++;
  }
  next.entries = next.entries.slice(removed);
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
export function codeOutputParts(text: string): CodeOutputKnownEntry["text"] {
  const parts: CodeOutputKnownEntry["text"] = [];
  let offset = 0;
  for (const match of text.matchAll(/\[secret:([A-Za-z_][A-Za-z0-9_]{0,63})\]/g)) {
    if (match.index > offset) parts.push({ type: "text", text: text.slice(offset, match.index) });
    parts.push({ type: "secret", name: match[1]! });
    offset = match.index + match[0].length;
  }
  if (offset < text.length) parts.push({ type: "text", text: text.slice(offset) });
  return parts;
}
