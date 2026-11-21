import type { CodeOutputEntry, CodeOutputEvent, CodeOutputKnownEntry, CodeOutputWindow } from "./output";
import { codeOutputJsonBytes as bytes } from "./output-size";

// Keep tail application separate from schema initialization so on-demand viewers
// do not add these reducers to islands that only read the output contract.
export function isCodeOutputLogEntry(entry: CodeOutputEntry): entry is Extract<CodeOutputKnownEntry, { kind: "log" }> {
  return entry.kind === "log";
}
export function isCodeOutputStepEntry(entry: CodeOutputEntry): entry is Extract<CodeOutputKnownEntry, { kind: "step" }> {
  return entry.kind === "step";
}
export const emptyCodeOutput = (generation = 0): CodeOutputWindow => ({
  generation,
  seq: 0,
  entries: [],
  droppedLines: 0,
  droppedBytes: 0,
});
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
