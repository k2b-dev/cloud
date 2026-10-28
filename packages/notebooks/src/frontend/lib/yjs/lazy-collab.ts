import { ChangeSet, Text } from "@codemirror/state";
import { diffChars } from "diff";
import type * as Y from "yjs";

/**
 * A note opens with its saved Markdown and no collaboration. The first edit
 * connects; until the live document arrives, the person's edits stay in the
 * editor. They are then carried onto the live text, which another editor may
 * have changed since the note was saved, and written to Yjs as one step.
 */

/** A diff that takes longer means two people rewrote the note at once; the edits then do not merge automatically. */
const CHAR_DIFF_TIMEOUT_MS = 300;

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

const textOf = (value: string) => Text.of(value.split("\n"));

/** The edits that turn `from` into `to`, in `from`'s positions; `null` when the texts are too far apart to diff in time. */
export const changesBetween = (from: string, to: string): ChangeSet | null => {
  if (from === to) return ChangeSet.empty(from.length);
  // The shared start and end bound the diff to the edited middle, so a long note stays cheap.
  const max = Math.min(from.length, to.length);
  let start = 0;
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++;
  // Never cut a character in two: an emoji is two UTF-16 units, and half of one is no text.
  if (start > 0 && isHighSurrogate(from.charCodeAt(start - 1))) start--;
  let end = 0;
  while (end < max - start && from.charCodeAt(from.length - 1 - end) === to.charCodeAt(to.length - 1 - end)) end++;
  if (end > 0 && isLowSurrogate(from.charCodeAt(from.length - end))) end--;
  const removed = from.slice(start, from.length - end);
  const added = to.slice(start, to.length - end);
  const parts = diffChars(removed, added, { timeout: CHAR_DIFF_TIMEOUT_MS });
  if (!parts) return null;
  const changes: Array<{ from: number; to?: number; insert?: string }> = [];
  let position = start;
  for (const part of parts) {
    if (part.added) changes.push({ from: position, insert: part.value });
    else if (part.removed) {
      changes.push({ from: position, to: position + part.value.length });
      position += part.value.length;
    } else position += part.value.length;
  }
  return ChangeSet.of(changes, from.length);
};

/**
 * The person's edits of `base`, now `edited`, carried onto `live`. Text both sides inserted at one place keeps the
 * live text first; an edit inside text another editor removed is dropped with that text, as in Yjs itself.
 */
export const rebaseOnto = (base: string, edited: string, live: string): { changes: ChangeSet; text: string } | null => {
  const local = changesBetween(base, edited);
  if (!local) return null;
  if (live === base) return { changes: local, text: edited };
  const remote = changesBetween(base, live);
  if (!remote) return null;
  const mapped = local.map(remote);
  return { changes: mapped, text: mapped.apply(textOf(live)).toString() };
};

/** Writes changes made against the text's current content, last position first, so earlier positions stay valid. */
export const applyToYText = (ytext: Y.Text, changes: ChangeSet, origin: unknown) => {
  const edits: Array<{ from: number; to: number; insert: string }> = [];
  changes.iterChanges((from, to, _fromB, _toB, inserted) => edits.push({ from, to, insert: inserted.toString() }));
  if (edits.length === 0) return;
  ytext.doc!.transact(() => {
    for (const edit of edits.reverse()) {
      if (edit.to > edit.from) ytext.delete(edit.from, edit.to - edit.from);
      if (edit.insert) ytext.insert(edit.from, edit.insert);
    }
  }, origin);
};
