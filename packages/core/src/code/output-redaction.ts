import { type CodeOutputBatch, type CodeOutputKnownEntry, cleanCodeOutput, codeOutputParts } from "@k2b/cloud/code";

type Fragment = CodeOutputBatch["entries"][number];
type RedactedOutputEntry = Omit<CodeOutputKnownEntry, "id">;
type Match = { length: number; marker: string };
type Node = {
  next: Map<string, Node>;
  depth: number;
  fail: Node;
  match?: Match;
  descendant?: string;
};
export type OutputRedactionPending = (Fragment & { name: string }) | null;

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
type Span = { start: number; end: number; marker: string };

function scan(text: string, redactor: OutputRedactor) {
  const { root } = redactor;
  let node = root;
  const spans: Span[] = [];
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
    let start = end - node.match.length;
    let marker = node.match.marker;
    // Only the longest terminal suffix is needed: all shorter matches ending
    // here are contained. Merge overlapping spans conservatively. Each span is
    // pushed/popped once; no enumeration of a quadratic suffix-output list.
    while (spans.length && spans.at(-1)!.end > start) {
      const previous = spans.pop()!;
      if (previous.start < start) marker = previous.marker;
      start = Math.min(start, previous.start);
    }
    spans.push({ start, end, marker });
  }
  // The earliest uncovered prefix must wait. A complete marker may already
  // cover a longer candidate, while a shorter failure suffix is still open.
  // Candidates and spans both move forward; each is visited at most once.
  let spanIndex = 0;
  while (node !== root) {
    const start = text.length - node.depth;
    while (spans[spanIndex] && spans[spanIndex]!.end <= start) spanIndex++;
    const span = spans[spanIndex];
    if (node.next.size && !(span && span.start < start && span.end > start)) break;
    node = node.fail;
  }
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
    entries.push({ kind: pending.kind, level: pending.level, at: pending.at, text: [{ type: "secret", name: pending.name }] });
    pending = null;
  }
  const cleaned = input.flatMap(({ kind, level, at, text }) =>
    text.split(/\r\n|\n|\r/).map((text) => ({ kind, level, at, text: cleanCodeOutput(text) })),
  );
  if (continuity.lost && redactor.longest > 0) {
    for (const fragment of cleaned) {
      dropped.lines++;
      dropped.bytes += Buffer.byteLength(JSON.stringify(fragment));
    }
    return { entries, pending: null, skip: redactor.longest - 1, dropped };
  }
  const fragments = [
    ...(pending ? [pending] : []),
    ...cleaned.filter((fragment) => {
      if (skip <= 0) return true;
      skip = Math.max(0, skip - fragment.text.length);
      dropped.lines++;
      dropped.bytes += Buffer.byteLength(JSON.stringify(fragment));
      return false;
    }),
  ];
  const text = fragments.map((fragment) => fragment.text).join("");
  const { spans, heldAt, name } = scan(text, redactor);
  const emitted = fragments.map(() => "");
  let line = 0;
  let lineEnd = fragments[0]?.text.length ?? 0;
  let offset = 0;
  let spanIndex = 0;
  const end = final ? text.length : heldAt;
  while (offset < end) {
    while (line + 1 < fragments.length && offset >= lineEnd) lineEnd += fragments[++line]!.text.length;
    if (final && offset === heldAt && heldAt < text.length) {
      emitted[line] += `[secret:${name}]`;
      break;
    }
    const span = spans[spanIndex];
    if (span && span.start === offset) {
      emitted[line] += span.marker;
      offset = span.end;
      spanIndex++;
    } else {
      const next = Math.min(lineEnd, end, heldAt < text.length ? heldAt : end, span?.start ?? end);
      emitted[line] += text.slice(offset, next);
      offset = next;
    }
  }
  let held: OutputRedactionPending = null;
  if (!final && heldAt < text.length) {
    // Metadata belongs to the fragment where the candidate starts.
    let start = 0;
    for (const fragment of fragments) {
      if (start + fragment.text.length > heldAt) {
        held = { ...fragment, text: text.slice(heldAt), name: name! };
        break;
      }
      start += fragment.text.length;
    }
  }
  let start = 0;
  entries.push(
    ...fragments.flatMap((fragment, index) => {
      const before = start;
      start += fragment.text.length;
      if (held && before >= heldAt && !emitted[index]) return [];
      return [{ kind: fragment.kind, level: fragment.level, at: fragment.at, text: codeOutputParts(cleanCodeOutput(emitted[index]!)) }];
    }),
  );
  return { entries, pending: held, skip, dropped };
}
