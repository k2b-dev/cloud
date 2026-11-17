import { type CodeOutputBatch, type CodeOutputKnownEntry, CodeOutputBatchSchema, cleanCodeOutput, codeOutputParts } from "@k2b/cloud/code";

import { z } from "zod";
type RedactedOutputEntry = Omit<CodeOutputKnownEntry, "id">;
type Match = { length: number; marker: string };
type Node = {
  next: Map<string, Node>;
  depth: number;
  fail: Node;
  match?: Match;
  descendant?: string;
};
export const OutputRedactionPendingSchema = CodeOutputBatchSchema.shape.entries.element.extend({
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
  for (const [raw, marker] of replacements) {
    const value = cleanCodeOutput(raw);
    if (!value) continue;
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
  return { root, longest };
}
export type OutputRedactor = ReturnType<typeof compileOutputRedaction>;
type Span = { start: number; end: number; marker: string; prior?: boolean };

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
  input: CodeOutputBatch["entries"],
  redactor: OutputRedactor,
  pending: OutputRedactionPending = null,
  final = false,
  continuity: { lost: boolean; skip: number } = { lost: false, skip: 0 },
): { entries: RedactedOutputEntry[]; pending: OutputRedactionPending; skip: number; dropped: { lines: number; bytes: number } } {
  const entries: RedactedOutputEntry[] = [];
  const dropped = { lines: 0, bytes: 0 };
  let skip = continuity.skip;
  if (pending && ((final && !input.length) || continuity.lost)) {
    if ((pending.hidden ?? 0) < pending.text.length || pending.covered)
      entries.push({ kind: pending.kind, level: pending.level, at: pending.at, text: [{ type: "secret", name: pending.name }] });
    pending = null;
  }
  const suppressBatch = continuity.lost && redactor.longest > 0;
  const fragments = [
    ...(pending ? [{ ...pending, suppressed: (pending.hidden ?? 0) === pending.text.length && !pending.covered }] : []),
    ...input.flatMap(({ kind, level, at, text }) =>
      text.split(/\r\n|\n|\r/).map((text) => {
        const fragment = { kind, level, at, text: cleanCodeOutput(text) };
        const suppressed = suppressBatch || skip > 0;
        if (suppressed) {
          if (!suppressBatch) skip = Math.max(0, skip - fragment.text.length);
          dropped.lines++;
          dropped.bytes += Buffer.byteLength(JSON.stringify(fragment));
        }
        return { ...fragment, suppressed };
      }),
    ),
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
          kind: fragment.kind, level: fragment.level, at: fragment.at,
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
  entries.push(...fragments.flatMap((fragment, index) => {
    const before = start;
    start += fragment.text.length;
    if (!emitted[index] && (fragment.suppressed || (held && before >= end))) return [];
    return [{ kind: fragment.kind, level: fragment.level, at: fragment.at, text: codeOutputParts(cleanCodeOutput(emitted[index]!)) }];
  }));
  return { entries, pending: held, skip, dropped };
}
