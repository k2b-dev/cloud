/**
 * Subscript and Superscript extension for CodeMirror.
 *
 *     H~2~O           ← `~2~` rendered with `vertical-align: sub`
 *     E=mc^2^         ← `^2^` rendered with `vertical-align: super`
 *
 * The lezer markdown parser doesn't model these, so we scan the doc with
 * regex and decorate inner spans. Markers stay visible (KISS — same as
 * `==mark==`); the visual sub/super-shift is enough signal.
 *
 * Carefully scoped regexes:
 *  - subscript: a single `~`, the inner content has no whitespace or `~`,
 *    closing `~` not adjacent to another `~`. Avoids stomping on
 *    GFM strikethrough (`~~text~~`).
 *  - superscript: a single `^`, no whitespace, closing `^`.
 */

import type { EditorState, Extension, Range, Transaction } from "@codemirror/state";
import { RangeSet, StateField } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { Decoration, EditorView } from "@codemirror/view";
import { SUB_REGEX, SUP_REGEX } from "./_lib/inline-syntax";

const subDecoration = Decoration.mark({ class: "cm-subscript" });
const supDecoration = Decoration.mark({ class: "cm-superscript" });

type SubSupState = {
  decorations: DecorationSet;
  ranges: Array<{ from: number; to: number }>;
};

const findSubSup = (state: EditorState): SubSupState => {
  const decorations: Range<Decoration>[] = [];
  const ranges: Array<{ from: number; to: number }> = [];
  const text = state.doc.toString();
  for (const match of text.matchAll(SUB_REGEX)) {
    if (match.index === undefined) continue;
    const from = match.index;
    const to = match.index + match[0].length;
    decorations.push(subDecoration.range(from, to));
    ranges.push({ from, to });
  }
  for (const match of text.matchAll(SUP_REGEX)) {
    if (match.index === undefined) continue;
    const from = match.index;
    const to = match.index + match[0].length;
    decorations.push(supDecoration.range(from, to));
    ranges.push({ from, to });
  }
  // Decorations must be in document order for RangeSet.of(..., true).
  decorations.sort((a, b) => a.from - b.from);
  ranges.sort((a, b) => a.from - b.from);
  return { decorations: RangeSet.of(decorations, true), ranges };
};

const intersectsRanges = (ranges: Array<{ from: number; to: number }>, from: number, to: number): boolean =>
  ranges.some((range) => from <= range.to && to >= range.from);

const changesMightAffectSubSup = (tr: Transaction, ranges: Array<{ from: number; to: number }>): boolean => {
  let might = false;
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    if (might) return;
    if (intersectsRanges(ranges, fromA, toA)) {
      might = true;
      return;
    }
    if (/[~^]/.test(inserted.toString())) {
      might = true;
      return;
    }
    const from = Math.max(0, fromB - 2);
    const to = Math.min(tr.state.doc.length, toB + 2);
    might = /[~^]/.test(tr.state.doc.sliceString(from, to));
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

export const subSupExtension = (): Extension => {
  const stateField = StateField.define<SubSupState>({
    create(state) {
      return findSubSup(state);
    },
    update(value, tr) {
      if (tr.docChanged) {
        if (changesMightAffectSubSup(tr, value.ranges)) return findSubSup(tr.state);
        return { decorations: value.decorations.map(tr.changes), ranges: mapRanges(tr, value.ranges) };
      }
      return value;
    },
    provide(field) {
      return EditorView.decorations.from(field, (value) => value.decorations);
    },
  });

  const theme = EditorView.theme({
    ".cm-subscript": {
      verticalAlign: "sub",
      fontSize: "0.75em",
    },
    ".cm-superscript": {
      verticalAlign: "super",
      fontSize: "0.75em",
    },
  });

  return [stateField, theme];
};
