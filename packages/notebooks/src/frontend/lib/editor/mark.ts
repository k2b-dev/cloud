/**
 * Mark / Highlight extension for CodeMirror.
 *
 * Detects `==text==` spans and decorates them with a yellow textmarker
 * background. The lezer markdown parser does NOT recognise this syntax
 * (it's not in CommonMark / GFM), so we scan the doc with a regex and
 * apply `Decoration.mark` for each match. For typical note sizes the
 * full-doc scan is microseconds — well within tick budget.
 */

import type { EditorState, Extension, Range, Transaction } from "@codemirror/state";
import { RangeSet, StateField } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { Decoration, EditorView } from "@codemirror/view";
import { MARK_REGEX } from "./_lib/inline-syntax";

const markDecoration = Decoration.mark({ class: "cm-mark-highlight" });

type MarkState = {
  decorations: DecorationSet;
  ranges: Array<{ from: number; to: number }>;
};

const findMarks = (state: EditorState): MarkState => {
  const decorations: Range<Decoration>[] = [];
  const ranges: Array<{ from: number; to: number }> = [];
  const text = state.doc.toString();
  for (const match of text.matchAll(MARK_REGEX)) {
    if (match.index === undefined) continue;
    const from = match.index;
    const to = from + match[0].length;
    decorations.push(markDecoration.range(from, to));
    ranges.push({ from, to });
  }
  return { decorations: RangeSet.of(decorations, true), ranges };
};

const intersectsRanges = (ranges: Array<{ from: number; to: number }>, from: number, to: number): boolean =>
  ranges.some((range) => from <= range.to && to >= range.from);

const changesMightAffectMarks = (tr: Transaction, ranges: Array<{ from: number; to: number }>): boolean => {
  let might = false;
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    if (might) return;
    if (intersectsRanges(ranges, fromA, toA)) {
      might = true;
      return;
    }
    if (inserted.toString().includes("=")) {
      might = true;
      return;
    }
    const from = Math.max(0, fromB - 2);
    const to = Math.min(tr.state.doc.length, toB + 2);
    might = tr.state.doc.sliceString(from, to).includes("=");
  });
  return might;
};

const mapRanges = (tr: Transaction, ranges: Array<{ from: number; to: number }>): Array<{ from: number; to: number }> =>
  ranges
    .map((range) => ({
      from: tr.changes.mapPos(range.from, 1),
      to: tr.changes.mapPos(range.to, -1),
    }))
    .filter((range) => range.from < range.to);

export const markExtension = (): Extension => {
  const stateField = StateField.define<MarkState>({
    create(state) {
      return findMarks(state);
    },
    update(value, tr) {
      if (tr.docChanged) {
        if (changesMightAffectMarks(tr, value.ranges)) return findMarks(tr.state);
        return { decorations: value.decorations.map(tr.changes), ranges: mapRanges(tr, value.ranges) };
      }
      return value;
    },
    provide(field) {
      return EditorView.decorations.from(field, (value) => value.decorations);
    },
  });

  // Match the renderer's `<mark>` styling so edit-mode and read-mode look
  // the same. Neon-yellow textmarker — saturated yellow-300 with dark text
  // for the punchy real-highlighter feel (the previous yellow-100 read as
  // muted cream / sand).
  const theme = EditorView.theme({
    ".cm-mark-highlight": {
      backgroundColor: "rgb(253 224 71)", // yellow-300
      color: "rgb(24 24 27)", // zinc-900
      borderRadius: "2px",
      padding: "0 2px",
    },
    ".dark .cm-mark-highlight": {
      backgroundColor: "rgba(250 204 21 / 0.4)", // yellow-400 @ 40%
      color: "rgb(254 252 232)", // yellow-50
    },
  });

  return [stateField, theme];
};
