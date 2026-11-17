import { type CodeOutputBatch, type CodeOutputKnownEntry, cleanCodeOutput, codeOutputParts } from "@k2b/cloud/code";

type Fragment = CodeOutputBatch["entries"][number];
type RedactedOutputEntry = Omit<CodeOutputKnownEntry, "id">;
type Node = { next: Map<string, Node>; marker?: string; descendant?: string };
export type OutputRedactionPending = (Fragment & { name: string }) | null;

/** Compiled once per replacement revision. Line and transport boundaries are not secret boundaries. */
export function compileOutputRedaction(replacements: ReadonlyMap<string, string>) {
  const root: Node = { next: new Map() };
  let longest = 0;
  for (const [raw, marker] of replacements) {
    const value = cleanCodeOutput(raw);
    if (!value) continue;
    longest = Math.max(longest, value.length);
    let node = root;
    // Match JavaScript string units so a transported fragment may end inside a surrogate pair.
    for (let index = 0; index < value.length; index++) {
      const char = value[index]!;
      let child = node.next.get(char);
      if (!child) {
        child = { next: new Map() };
        node.next.set(char, child);
      }
      node = child;
      node.descendant ??= marker;
    }
    node.marker = marker;
  }
  return { root, longest };
}
export type OutputRedactor = ReturnType<typeof compileOutputRedaction>;

/** Only an unresolved suffix is retained, shorter than the longest replacement.
 * Its text remains encrypted by the caller. Unresolved fragments may coalesce
 * across lines; finalization emits a named marker, never a possible secret prefix.
 */
export function redactOutput(
  input: CodeOutputBatch["entries"],
  redactor: OutputRedactor,
  pending: OutputRedactionPending = null,
  final = false,
): { entries: RedactedOutputEntry[]; pending: OutputRedactionPending } {
  if (final && pending && input.length === 0)
    return {
      entries: [{ kind: pending.kind, level: pending.level, at: pending.at, text: [{ type: "secret", name: pending.name }] }],
      pending: null,
    };
  const fragments = [
    ...(pending ? [pending] : []),
    ...input.flatMap(({ kind, level, at, text }) =>
      text.split(/\r\n|\n|\r/).map((text) => ({ kind, level, at, text: cleanCodeOutput(text) })),
    ),
  ];
  const text = fragments.map((line) => line.text).join("");
  const emitted = fragments.map(() => "");
  let offset = 0;
  let line = 0;
  let lineEnd = fragments[0]?.text.length ?? 0;
  let held: OutputRedactionPending = null;
  let heldAt = text.length;
  while (offset < text.length) {
    while (line + 1 < fragments.length && offset >= lineEnd) lineEnd += fragments[++line]!.text.length;
    let node = redactor.root;
    let end = offset;
    let match: { end: number; marker: string } | undefined;
    while (end < text.length) {
      const char = text[end]!;
      const next = node.next.get(char);
      if (!next) break;
      node = next;
      end++;
      if (node.marker) match = { end, marker: node.marker };
    }
    if (end === text.length && node.next.size && end > offset) {
      if (final) emitted[line] += node.descendant!;
      else {
        const fragment = fragments[line]!;
        held = {
          kind: fragment.kind,
          level: fragment.level,
          at: fragment.at,
          text: text.slice(offset),
          name: node.descendant!.slice("[secret:".length, -1),
        };
        heldAt = offset;
      }
      break;
    }
    if (match) {
      emitted[line] += match.marker;
      offset = match.end;
    } else {
      emitted[line] = emitted[line]! + text[offset]!;
      offset++;
    }
  }
  let start = 0;
  return {
    entries: fragments.flatMap((fragment, index) => {
      const before = start;
      start += fragment.text.length;
      if (held && before >= heldAt && !emitted[index]) return [];
      return [{ kind: fragment.kind, level: fragment.level, at: fragment.at, text: codeOutputParts(cleanCodeOutput(emitted[index]!)) }];
    }),
    pending: held,
  };
}
