import {
  CODE_OUTPUT_STEP_LIMITS,
  CODE_OUTPUT_STEP_TEXT_FIELDS,
  type CodeOutputBatch,
  type CodeOutputKnownEntry,
  CodeOutputLogInputSchema,
  CodeOutputStepEntrySchema,
  type CodeOutputText,
  cleanCodeOutput,
  codeOutputParts,
} from "@k2b/cloud/code";

import { z } from "zod";

const StepFragmentSchema = z.object({
  entry: CodeOutputStepEntrySchema,
  field: z.enum(CODE_OUTPUT_STEP_TEXT_FIELDS),
});
const FragmentSchema = CodeOutputLogInputSchema.extend({ step: StepFragmentSchema.optional() });
type Fragment = z.infer<typeof FragmentSchema>;
type RedactedOutputEntry = Omit<Fragment, "text"> & { text: CodeOutputText };
type Match = { length: number; marker: string };
type Node = {
  next: Map<string, Node>;
  depth: number;
  fail: Node;
  match?: Match;
  descendant?: string;
};
export const OutputRedactionPendingSchema = FragmentSchema.extend({
  text: z.string(),
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
  /** UTF-16 prefix already counted as suppressed; never release it as plain text. */
  hidden: z.number().int().nonnegative().safe().optional(),
  /** Deferred complete-match prefix overlapping the open candidate, sharing its metadata/name. */
  covered: z.number().int().positive().safe().optional(),
});
export type OutputRedactionPending = z.infer<typeof OutputRedactionPendingSchema> | null;

/** Aho-Corasick, compiled once per replacement revision. Failure links keep scanning amortized
 * linear in UTF-16 input units, including repetitive, overlapping prefixes.
 */
export function compileOutputRedaction(replacements: ReadonlyMap<string, string>) {
  const root: Node = {
    next: new Map(),
    depth: 0,
    get fail() {
      return root;
    },
  };
  let longest = 0;
  const spellings: string[] = [];
  for (const [raw, marker] of replacements) {
    const value = cleanCodeOutput(raw);
    if (!value) continue;
    spellings.push(value);
    longest = Math.max(longest, value.length);
    let node = root;
    // Match string units: a transported fragment may end inside a surrogate pair.
    for (let index = 0; index < value.length; index++) {
      const char = value[index]!;
      let child = node.next.get(char);
      if (!child) {
        child = { next: new Map(), depth: node.depth + 1, fail: root };
        node.next.set(char, child);
      }
      node = child;
      node.descendant ??= marker;
    }
    node.match = { length: value.length, marker };
  }
  const queue = [...root.next.values()];
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index]!;
    node.match ??= node.fail.match;
    for (const [char, child] of node.next) {
      let fail = node.fail;
      while (fail !== root && !fail.next.has(char)) fail = fail.fail;
      child.fail = fail.next.get(char) ?? root;
      queue.push(child);
    }
  }
  return { root, longest, spellings };
}
export type OutputRedactor = ReturnType<typeof compileOutputRedaction>;
type Span = { start: number; end: number; marker: string; prior?: boolean };

/** A missing batch may end anywhere in a spelling. Check whether this batch's
 * prefix could continue it, including a continuation still awaiting later text.
 * KMP scans the bounded spellings and input once, without enumerating suffixes.
 */
function couldContinueOutput(text: string, spellings: readonly string[]) {
  if (!text.length) return true;
  const failure = new Uint32Array(text.length);
  for (let index = 1; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    let matched = failure[index - 1]!;
    let next = text.charCodeAt(matched);
    while (matched > 0 && unit !== next) {
      matched = failure[matched - 1]!;
      next = text.charCodeAt(matched);
    }
    failure[index] = matched + Number(unit === next);
  }
  for (const spelling of spellings) {
    let matched = 0;
    for (let index = 0; index < spelling.length; index++) {
      const unit = spelling.charCodeAt(index);
      let next = text.charCodeAt(matched);
      while (matched > 0 && unit !== next) {
        matched = failure[matched - 1]!;
        next = text.charCodeAt(matched);
      }
      if (unit === next) matched++;
      if (matched === text.length) return true;
    }
    if (matched > 0) return true;
  }
  return false;
}

function mergeSpan(spans: Span[], span: Span) {
  // Each span is pushed/popped once. Shorter terminal suffixes are contained in
  // the longest match, so scanning needs no potentially quadratic output list.
  while (spans.length && spans.at(-1)!.end > span.start) {
    const previous = spans.pop()!;
    if (previous.start < span.start || previous.prior) span.marker = previous.marker;
    span.start = Math.min(span.start, previous.start);
    span.end = Math.max(span.end, previous.end);
    span.prior ||= previous.prior;
  }
  spans.push(span);
}

function scan(text: string, redactor: OutputRedactor, covered?: Span) {
  const { root } = redactor;
  let node = root;
  const spans: Span[] = covered ? [covered] : [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    let next = node.next.get(char);
    while (!next && node !== root) {
      node = node.fail;
      next = node.next.get(char);
    }
    node = next ?? root;
    if (!node.match) continue;
    const end = index + 1;
    mergeSpan(spans, { start: end - node.match.length, end, marker: node.match.marker });
  }
  // Keep the longest open suffix even when a complete match overlaps its start.
  // Only the raw suffix waits; its already recognized prefix is recorded separately.
  while (node !== root && !node.next.size) node = node.fail;
  return { spans, heldAt: text.length - node.depth, name: node.descendant?.slice("[secret:".length, -1) };
}

/** Only an unresolved suffix is retained, shorter than the longest replacement.
 * Its text remains encrypted by the caller. A gap closes it as a marker. Since
 * aggregate loss counters carry no position, discard that batch and a following
 * longest-pattern suffix in UTF-16 units (whole entries), counting additional losses. Never
 * join a pre-gap candidate to post-gap text or release it after a mismatch.
 */
export function redactOutput(
  input: readonly Fragment[],
  redactor: OutputRedactor,
  pending: OutputRedactionPending = null,
  final = false,
  continuity: { lost: boolean; skip: number; lossBeforeBatch?: boolean } = { lost: false, skip: 0 },
): { entries: RedactedOutputEntry[]; pending: OutputRedactionPending; skip: number; dropped: { lines: number; bytes: number } } {
  const entries: RedactedOutputEntry[] = [];
  const dropped = { lines: 0, bytes: 0 };
  let skip = continuity.skip;
  const hadPending = pending !== null;
  if (pending && ((final && !input.length) || continuity.lost)) {
    if ((pending.hidden ?? 0) < pending.text.length || pending.covered)
      entries.push({
        kind: pending.kind,
        level: pending.level,
        at: pending.at,
        ...(pending.step ? { step: pending.step } : {}),
        text: [{ type: "secret", name: pending.name }],
      });
    pending = null;
  }
  const cleaned = input.flatMap(({ text, ...metadata }) =>
    text.split(/\r\n|\n|\r/).map((text) => ({ ...metadata, text: cleanCodeOutput(text) })),
  );
  // With a resolved previous boundary and loss known to precede this whole batch,
  // unrelated text can resume immediately. Unknown positions and open candidates
  // keep the conservative suppression, including scanning its hidden end candidate.
  const resumes =
    continuity.lost &&
    continuity.lossBeforeBatch &&
    !hadPending &&
    skip === 0 &&
    !couldContinueOutput(cleaned.map((fragment) => fragment.text).join(""), redactor.spellings);
  const suppressBatch = continuity.lost && redactor.longest > 0 && !resumes;
  const suppressedSteps = new Set<object>();
  const fragments = [
    ...(pending ? [{ ...pending, suppressed: (pending.hidden ?? 0) === pending.text.length && !pending.covered }] : []),
    ...cleaned.map((fragment) => {
      const suppressed = suppressBatch || skip > 0;
      if (suppressed) {
        if (!suppressBatch) skip = Math.max(0, skip - fragment.text.length);
        if (!fragment.step || !suppressedSteps.has(fragment.step.entry)) dropped.lines++;
        if (fragment.step) suppressedSteps.add(fragment.step.entry);
        dropped.bytes += Buffer.byteLength(JSON.stringify(fragment));
      }
      return { ...fragment, suppressed };
    }),
  ];
  if (suppressBatch) skip = redactor.longest - 1;
  // Suppression is a leading region (the affected batch or following entries).
  // Still scan it: candidates at its end must continue into subsequent input.
  let hiddenUntil = pending?.hidden ?? 0;
  let start = 0;
  for (const fragment of fragments) {
    start += fragment.text.length;
    if (fragment.suppressed) hiddenUntil = start;
  }
  const text = fragments.map((fragment) => fragment.text).join("");
  const covered = pending?.covered ? { start: 0, end: pending.covered, marker: `[secret:${pending.name}]`, prior: true } : undefined;
  const { spans, heldAt, name } = scan(text, redactor, covered);
  if (final && heldAt < text.length) mergeSpan(spans, { start: heldAt, end: text.length, marker: `[secret:${name}]` });
  const deferred = final ? undefined : spans.find((span) => span.start <= heldAt && span.end > heldAt);
  const end = final ? text.length : (deferred?.start ?? heldAt);
  const emitted = fragments.map(() => "");
  let line = 0;
  let lineEnd = fragments[0]?.text.length ?? 0;
  const moveTo = (offset: number) => {
    while (line + 1 < fragments.length && offset >= lineEnd) lineEnd += fragments[++line]!.text.length;
  };
  let offset = 0;
  let spanIndex = 0;
  while (offset < end) {
    moveTo(offset);
    const span = spans[spanIndex];
    if (span && span.start === offset) {
      if (span.end > hiddenUntil || (covered && span.start === 0)) {
        moveTo(Math.max(offset, Math.min(hiddenUntil, span.end - 1)));
        emitted[line] += span.marker;
      }
      offset = span.end;
      spanIndex++;
    } else {
      const next = Math.min(lineEnd, end, span?.start ?? end);
      if (next > hiddenUntil) emitted[line] += text.slice(Math.max(offset, hiddenUntil), next);
      offset = next;
    }
  }
  let held: OutputRedactionPending = null;
  if (!final && heldAt < text.length) {
    // A complete overlapping area waits as a marker plus the bounded raw suffix.
    // This keeps both earlier metadata and later candidates without retaining old raw text.
    const retained = deferred && (deferred.start < heldAt || covered) && (deferred.end > hiddenUntil || covered) ? deferred : undefined;
    const metadataAt = retained?.start ?? heldAt;
    let position = 0;
    for (const fragment of fragments) {
      if (position + fragment.text.length > metadataAt) {
        held = {
          ...(fragment.step ? { step: fragment.step } : {}),
          kind: fragment.kind,
          level: fragment.level,
          at: fragment.at,
          text: text.slice(heldAt),
          name: retained ? retained.marker.slice("[secret:".length, -1) : name!,
          ...(hiddenUntil > heldAt ? { hidden: hiddenUntil - heldAt } : {}),
          ...(retained ? { covered: retained.end - heldAt } : {}),
        };
        break;
      }
      position += fragment.text.length;
    }
  }
  start = 0;
  entries.push(
    ...fragments.flatMap((fragment, index) => {
      const before = start;
      start += fragment.text.length;
      if (!emitted[index] && !fragment.step && (fragment.suppressed || (held && before >= end))) return [];
      return [
        {
          kind: fragment.kind,
          level: fragment.level,
          at: fragment.at,
          ...(fragment.step ? { step: fragment.step } : {}),
          text: codeOutputParts(cleanCodeOutput(emitted[index]!)),
        },
      ];
    }),
  );
  if (held?.step) {
    // A deferred suffix may span several revisions of the same step. Its later
    // completion must update the latest snapshot, without restoring an old status.
    const stepId = held.step.entry.id;
    const latest = input.findLast((fragment) => fragment.step?.entry.id === stepId)?.step;
    if (latest) held.step = { ...held.step, entry: latest.entry };
  }
  return { entries, pending: held, skip, dropped };
}

/** Step fields participate in the same continuous matcher as console text. Only sanitized
 * snapshots travel in fragment metadata. An unresolved field suffix stays in the encrypted
 * pending envelope and completes the same step ID in a later delta or at final settlement.
 */
export type OutputSteps = Record<string, z.infer<typeof CodeOutputStepEntrySchema>>;
const terminalStep = (status: string) => ["succeeded", "failed", "skipped"].includes(status);
/** Accepted metadata is canonical, bounded by the admitted handle count and output
 * budget. Revisions advance lifecycle only; repeated text never re-enters the matcher.
 */
const stepReserve = (entry: z.infer<typeof CodeOutputStepEntrySchema>) =>
  Buffer.byteLength(
    JSON.stringify({
      ...entry,
      status: "succeeded",
      startedAt: entry.at,
      endedAt: entry.at,
      // A running handle can always close with the stable termination reason.
      message: entry.message?.length ? entry.message : [{ type: "text", text: "code_run_ended" }],
    }),
  );
const stepsBytes = (steps: OutputSteps) =>
  Object.values(steps).reduce((size, entry) => size + stepReserve(entry) + Buffer.byteLength(JSON.stringify(entry.id)) + 2, 2);
export function codeOutputFragments(
  input: CodeOutputBatch["entries"],
  generation: number,
  steps: OutputSteps = {},
  budget = Infinity,
  dropped = { lines: 0, bytes: 0 },
): Fragment[] {
  return input.flatMap((entry): Fragment[] => {
    if (entry.kind === "log") return [entry];
    // Capture timestamps have millisecond precision in the host. Normalize the
    // transport spelling before budgeting lifecycle metadata (ISO permits longer fractions).
    const timestamp = (value: string) => {
      const at = Date.parse(value);
      return Number.isFinite(at) ? new Date(at).toISOString() : null;
    };
    const at = timestamp(entry.at);
    const startedAt = entry.startedAt === undefined ? undefined : timestamp(entry.startedAt);
    const endedAt = entry.endedAt === undefined ? undefined : timestamp(entry.endedAt);
    if (!at || startedAt === null || endedAt === null) return [];
    entry = { ...entry, at, startedAt, endedAt };
    const id = `${generation}:step:${entry.id}`;
    let safe = steps[id];
    const first = safe === undefined;
    if (safe) {
      if (terminalStep(safe.status) || entry.at !== safe.at) return [];
      const allowed = safe.status === "pending" ? ["running", "failed", "skipped"].includes(entry.status) : terminalStep(entry.status);
      if (!allowed) return [];
      // Capture time is author-provided, but lifecycle must never move backwards.
      const priorAt = safe.startedAt ?? safe.at;
      if (entry.status === "running") {
        if (!entry.startedAt || entry.startedAt < priorAt || entry.endedAt !== undefined) return [];
        safe.startedAt = entry.startedAt;
      } else {
        if (!entry.endedAt || entry.endedAt < priorAt) return [];
        if (entry.startedAt !== safe.startedAt) return [];
        safe.endedAt = entry.endedAt;
      }
      safe.status = entry.status;
    } else {
      if (Object.keys(steps).length >= CODE_OUTPUT_STEP_LIMITS.count) {
        dropped.lines++;
        dropped.bytes += Buffer.byteLength(JSON.stringify(entry));
        return [];
      }
      // Missing earlier deltas can make the first admitted revision running or
      // terminal. It still has to carry a complete, monotone lifecycle snapshot.
      if (entry.status === "pending" && (entry.startedAt || entry.endedAt)) return [];
      if (entry.status === "running" && (!entry.startedAt || entry.endedAt)) return [];
      if (terminalStep(entry.status) && (!entry.endedAt || (entry.status === "succeeded" && !entry.startedAt))) return [];
      if (entry.startedAt && entry.startedAt < entry.at) return [];
      if (entry.endedAt && entry.endedAt < (entry.startedAt ?? entry.at)) return [];
      safe = {
        kind: "step",
        id,
        at: entry.at,
        status: entry.status,
        label: [],
        ...(entry.description === undefined ? {} : { description: [] }),
        ...(entry.startedAt === undefined ? {} : { startedAt: entry.startedAt }),
        ...(entry.endedAt === undefined ? {} : { endedAt: entry.endedAt }),
      };
      if (stepsBytes(steps) + stepReserve(safe) + Buffer.byteLength(JSON.stringify(id)) + 2 > budget) {
        dropped.lines++;
        dropped.bytes += Buffer.byteLength(JSON.stringify(entry));
        return [];
      }
      steps[id] = safe;
    }
    const snapshot = safe;
    const fields = CODE_OUTPUT_STEP_TEXT_FIELDS.filter((field) =>
      field === "message" ? terminalStep(entry.status) && entry.message !== undefined : first && entry[field] !== undefined,
    );
    if (!fields.length) return [{ kind: "log", level: "info", at: safe.at, text: "", step: { entry: safe, field: "label" } }];
    return fields.map((field) => ({
      kind: "log",
      level: "info",
      at: entry.at,
      text: entry[field] ?? "",
      step: { entry: snapshot, field },
    }));
  });
}
/** JSON storage removes aliases. Rebind the deferred field to the canonical latest
 * lifecycle before scanning/finalizing; its already-redacted text is never replaced.
 */
export function bindOutputPending(pending: OutputRedactionPending, steps: OutputSteps) {
  if (pending?.step && steps[pending.step.entry.id]) pending.step.entry = steps[pending.step.entry.id]!;
  return pending;
}
export function assembleCodeOutput(
  fragments: readonly RedactedOutputEntry[],
  bounded?: { steps: OutputSteps; budget: number; dropped: { lines: number; bytes: number } },
): Array<Omit<Extract<CodeOutputKnownEntry, { kind: "log" }>, "id"> | Extract<CodeOutputKnownEntry, { kind: "step" }>> {
  const entries: ReturnType<typeof assembleCodeOutput> = [];
  const snapshots = new Set<object>();
  for (const { step, ...fragment } of fragments) {
    if (!step) {
      entries.push(fragment);
      continue;
    }
    if (step.field === "icon") {
      // Icons are identifiers, never display text or secret placeholders.
      const value = (step.entry.icon ?? "") + fragment.text.map((part) => (part.type === "text" ? part.text : "")).join("");
      if (fragment.text.every((part) => part.type === "text") && value.length <= 64 && /^[a-z0-9-]+$/.test(value)) step.entry.icon = value;
      else delete step.entry.icon;
    } else {
      const parts = step.entry[step.field] ?? [];
      parts.push(...fragment.text);
      step.entry[step.field] = parts;
    }
    let excess = bounded ? stepsBytes(bounded.steps) - bounded.budget : 0;
    if (bounded && excess > 0) {
      // New text parts use only the remaining admitted metadata budget. Never
      // evict already accepted fields or split a structural secret marker.
      if (step.field === "icon") delete step.entry.icon;
      else {
        const parts = step.entry[step.field] ?? [];
        // Account each removed part once; repeated full-map serialization here
        // would make trimming expanded named parts quadratic in their count.
        while (parts.length && excess > 0) {
          const part = parts.pop()!;
          const bytes = Buffer.byteLength(JSON.stringify(part));
          excess -= bytes + (parts.length ? 1 : 0);
          if (step.field === "message" && !parts.length)
            excess += Buffer.byteLength(JSON.stringify([{ type: "text", text: "code_run_ended" }])) - Buffer.byteLength("[]");
          bounded.dropped.bytes += bytes;
        }
      }
      bounded.dropped.lines++;
    }
    // The same safe snapshot may have several fields/fragments. Preserve its first
    // stream position; the shared window reducer upserts separate revisions by ID.
    if (!snapshots.has(step.entry)) {
      snapshots.add(step.entry);
      entries.push(step.entry);
    }
  }
  return entries;
}
