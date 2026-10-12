/** List indentation, subtree moves and local structural number repair, shared by keys and the toolbar. */
import { ensureSyntaxTree, language, syntaxTreeAvailable } from "@codemirror/language";
import {
  ChangeSet,
  type ChangeSpec,
  EditorState,
  type Extension,
  type Line,
  MapMode,
  Prec,
  type Text,
  Transaction,
} from "@codemirror/state";
import { type Command, keymap } from "@codemirror/view";
import type { Tree } from "@lezer/common";
import { ySyncAnnotation } from "y-codemirror.next";
import { LIST_ITEM, type ListItemLine, leadingWhitespace, listItemLine } from "./_lib/list-item-line";
import { type ExcludedSpan, excludedSpans, listStructure, markerChanges, renumberChanges, siblingIndex } from "./_lib/list-structure";
import { listStateField } from "./lists";

type Direction = 1 | -1;

const rawExcludedSpans = new WeakMap<Text, readonly ExcludedSpan[]>();
const excludedLines = (state: EditorState): (() => readonly ExcludedSpan[]) => {
  const listState = state.field(listStateField, false);
  let spans = listState ? listState.excluded : rawExcludedSpans.get(state.doc);
  return () => {
    if (!spans) {
      spans = excludedSpans(state);
      if (!listState) rawExcludedSpans.set(state.doc, spans);
    }
    return spans;
  };
};

const sameKind = (a: string, b: string) => a.at(-1) === b.at(-1);

/**
 * The nearest item above in the source, which also finds empty, not-yet-parsed items: `sibling` is the previous item
 * of the same list, `previous` any item at the same level (Tab nests under it, whatever its kind), `parent` the item
 * one level up.
 */
const itemAbove = (
  state: EditorState,
  line: Line,
  item: ListItemLine,
  relation: "sibling" | "previous" | "parent",
  excluded: () => readonly ExcludedSpan[],
  tree: Tree,
): Line | null => {
  for (let number = line.number - 1; number >= 1; number--) {
    const above = state.doc.line(number);
    if (!above.text.trim() || leadingWhitespace(above.text) > item.indent) continue;
    if (relation === "parent" && leadingWhitespace(above.text) === item.indent) continue;
    const candidate = listItemLine(tree, above, excluded);
    if (!candidate || relation === "parent") return candidate ? above : null;
    return candidate.indent === item.indent && (relation === "previous" || sameKind(candidate.marker, item.marker)) ? above : null;
  }
  return null;
};

const ordinalAt = (state: EditorState, line: Line, excluded: () => readonly ExcludedSpan[], tree: Tree): number => {
  let item = listItemLine(tree, line, excluded)!;
  let count = 0;
  for (
    let previous = itemAbove(state, line, item, "sibling", excluded, tree);
    previous;
    previous = itemAbove(state, line, item, "sibling", excluded, tree)
  ) {
    line = previous;
    item = listItemLine(tree, line, excluded)!;
    count++;
  }
  return Number.parseInt(item.marker, 10) + count;
};

const adoptedMarker = (state: EditorState, target: Line, offset: number, excluded: () => readonly ExcludedSpan[], tree: Tree): string => {
  const marker = listItemLine(tree, target, excluded)!.marker;
  return /^\d/.test(marker) ? `${ordinalAt(state, target, excluded, tree) + offset}${marker.at(-1)}` : marker;
};

/** Selection lines, excluding an unselected line at the end of a range like CodeMirror's line commands. */
const selectedLines = (state: EditorState): Line[] => {
  const lines: Line[] = [];
  let last = 0;
  for (const range of state.selection.ranges) {
    for (let pos = range.from; pos <= range.to; ) {
      const line = state.doc.lineAt(pos);
      if (line.number > last && (range.empty || range.to > line.from)) {
        lines.push(line);
        last = line.number;
      }
      pos = line.to + 1;
    }
  }
  return lines;
};

const nestedEnd = (state: EditorState, line: Line, indent: number): number => {
  let end = line.number;
  for (let number = line.number + 1; number <= state.doc.lines; number++) {
    const next = state.doc.line(number);
    if (next.text.trim() && leadingWhitespace(next.text) <= indent) break;
    end = number;
  }
  return end;
};

const shiftChanges = (state: EditorState, direction: Direction): ChangeSet | null => {
  const headLine = state.doc.lineAt(state.selection.main.head);
  if (!LIST_ITEM.test(headLine.text)) return null;
  // Keep the returned tree: parser progress need not have reached the state field yet.
  let tree = ensureSyntaxTree(state, headLine.to, 50);
  if (!tree) return state.changes([]);
  const excluded = excludedLines(state);
  const headItem = listItemLine(tree, headLine, excluded);
  if (!headItem) return null;
  if (state.readOnly) return state.changes([]);
  const above = itemAbove(state, headLine, headItem, direction > 0 ? "previous" : "parent", excluded, tree);
  const width = above
    ? direction > 0
      ? listItemLine(tree, above, excluded)!.content - headItem.indent
      : headItem.indent - listItemLine(tree, above, excluded)!.indent
    : direction < 0
      ? Math.min(headItem.indent, 2)
      : 0;
  if (!width && direction > 0) return state.changes([]);

  const lines = selectedLines(state);
  const upto = Math.max(headLine.to, lines.at(-1)?.to ?? 0);
  tree = ensureSyntaxTree(state, upto, 50);
  if (!tree) return state.changes([]);
  const deltas = new Map<number, number>();
  const markerItems: Array<{ line: number; to: number; markerFrom: number; markerTo: number }> = [];
  const markers = new Map<number, string>();
  const rewrite = (line: Line, item: ListItemLine, end: number, marker: string) => {
    markers.set(markerItems.length, marker);
    markerItems.push({
      line: line.number,
      to: state.doc.line(end).to,
      markerFrom: line.from + item.indent,
      markerTo: line.from + item.indent + item.marker.length,
    });
  };
  let last = 0;
  let previousTarget: Line | null = null;
  let targetOffset = 0;
  const lifted: Array<{ line: Line; item: ListItemLine; end: number; marker: string; width: number }> = [];
  for (const line of lines) {
    if (line.number <= last) continue;
    const item = listItemLine(tree, line, excluded);
    const end = item ? nestedEnd(state, line, item.indent) : line.number;
    let itemWidth = width;
    if (item) {
      // Following siblings may need a new marker when this item is lifted.
      const upto = state.doc.line(Math.min(state.doc.lines, end + 1)).to;
      tree = ensureSyntaxTree(state, upto, 50);
      if (!tree) return state.changes([]);
      const target = itemAbove(state, line, item, direction > 0 ? "previous" : "parent", excluded, tree);
      // A selection beginning with the first sibling cannot fabricate a nesting level either.
      if (direction > 0 && !target) return state.changes([]);
      itemWidth = target
        ? direction > 0
          ? (deltas.get(target.number) ?? listItemLine(tree, target, excluded)!.content - item.indent)
          : item.indent - listItemLine(tree, target, excluded)!.indent
        : Math.min(item.indent, 2);
      let marker = item.marker;
      if (target) {
        if (direction > 0) {
          const parent = listItemLine(tree, target, excluded)!;
          let child: Line | null = null;
          for (let number = target.number + 1; number < line.number; number++) {
            if (deltas.has(number)) continue;
            const candidate = state.doc.line(number);
            const parsed = listItemLine(tree, candidate, excluded);
            if (parsed && parsed.indent >= parent.content && (!child || parsed.indent <= listItemLine(tree, child, excluded)!.indent))
              child = candidate;
          }
          // Selected siblings all join the first selected item's destination list.
          const destination: Line | null = deltas.has(target.number) ? previousTarget : child;
          if (!deltas.has(target.number)) {
            previousTarget = destination;
            targetOffset = 0;
          }
          marker = destination
            ? adoptedMarker(state, destination, ++targetOffset, excluded, tree)
            : /^\d/.test(item.marker)
              ? `${++targetOffset}${item.marker.at(-1)}`
              : item.marker;
        } else {
          if (previousTarget?.number !== target.number) targetOffset = 0;
          previousTarget = target;
          marker = adoptedMarker(state, target, ++targetOffset, excluded, tree);
          lifted.push({ line, item, end, marker, width: itemWidth });
        }
      }
      rewrite(line, item, end, marker);
    }
    for (let number = line.number; number <= end; number++) deltas.set(number, direction * itemWidth);
    last = end;
  }
  for (const current of lifted) {
    const { item, end, marker, width } = current;
    // All remaining parent content becomes content of the lifted item, regardless of its kind.
    const delta = item.content - width + marker.length - item.marker.length - item.indent;
    const parent = itemAbove(state, current.line, item, "parent", excluded, tree);
    let followingEnd = parent ? nestedEnd(state, parent, listItemLine(tree, parent, excluded)!.indent) : state.doc.lines;
    const nextLifted = lifted.find((other) => other.line.number > end);
    if (nextLifted) followingEnd = Math.min(followingEnd, nextLifted.line.number - 1);
    for (let number = end + 1; number <= followingEnd; number++) if (!deltas.has(number)) deltas.set(number, delta);
    const next = end < followingEnd ? state.doc.line(end + 1) : null;
    const sibling = next && listItemLine(tree, next, excluded);
    if (next && sibling && sibling.indent === item.indent && sameKind(sibling.marker, item.marker) && /^\d/.test(sibling.marker))
      rewrite(next, sibling, nestedEnd(state, next, sibling.indent), `1${sibling.marker.at(-1)}`);
  }
  const specs: ChangeSpec[] = [];
  for (const [number, delta] of deltas) {
    const line = state.doc.line(number);
    if (!line.text.trim()) continue;
    if (delta > 0) specs.push({ from: line.from, insert: " ".repeat(delta) });
    else if (delta < 0) specs.push({ from: line.from, to: line.from + Math.min(-delta, /^ */.exec(line.text)![0].length) });
  }
  const indentation = state.changes(specs);
  // Compute width deltas on the shifted text: mapping two deletions of the same
  // leading spaces would otherwise collapse the second deletion.
  const shifted = EditorState.create({ doc: indentation.apply(state.doc) });
  const items = markerItems.map((item) => ({
    ...item,
    markerFrom: indentation.mapPos(item.markerFrom, 1),
    markerTo: indentation.mapPos(item.markerTo, 1),
    to: indentation.mapPos(item.to, 1),
  }));
  return indentation.compose(markerChanges(shifted, { items }, markers));
};

const shiftListItems =
  (direction: Direction): Command =>
  (view) => {
    const changes = shiftChanges(view.state, direction);
    if (!changes) return false;
    if (!changes.empty)
      view.dispatch({
        changes,
        selection: view.state.selection.map(changes, 1),
        scrollIntoView: true,
        userEvent: direction > 0 ? "input.indent" : "delete.dedent",
      });
    return true;
  };

export const indentListItems: Command = shiftListItems(1);
export const outdentListItems: Command = shiftListItems(-1);
export const listIndentAvailability = (state: EditorState): { indent: boolean; outdent: boolean } => {
  const disabled = { indent: false, outdent: false };
  const line = state.doc.lineAt(state.selection.main.head);
  if (state.readOnly || !LIST_ITEM.test(line.text)) return disabled;
  const tree = ensureSyntaxTree(state, line.to, 50);
  if (!tree) return disabled;
  const excluded = excludedLines(state);
  const item = listItemLine(tree, line, excluded);
  if (!item) return disabled;
  return {
    indent: !!itemAbove(state, line, item, "previous", excluded, tree),
    outdent: item.indent > 0,
  };
};

/** Top-level list blocks intersecting a source window, without descending into quotes or individual items. */
const listBlocks = (tree: Tree, range: ExcludedSpan): ExcludedSpan[] => {
  const blocks: ExcludedSpan[] = [];
  tree.iterate({
    ...range,
    enter(ref) {
      if (ref.name === "Blockquote") return false;
      if (ref.name !== "OrderedList" && ref.name !== "BulletList") return;
      if (ref.from < range.to && ref.to > range.from) blocks.push({ from: ref.from, to: ref.to });
      return false;
    },
  });
  return blocks;
};

/** A partial list grows as parsing advances. Re-find touched blocks until their closing boundaries are parsed. */
const parsedListBlocks = (
  state: EditorState,
  windows: readonly ExcludedSpan[],
  deadline = performance.now() + 50,
): { blocks: ExcludedSpan[]; tree: Tree } | null => {
  let upto = Math.min(state.doc.length, Math.max(...windows.map((window) => window.to)));
  for (;;) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return null;
    const tree = ensureSyntaxTree(state, upto, remaining);
    if (!tree) return null;
    const blocks = new Map<number, ExcludedSpan>();
    for (const window of windows) for (const block of listBlocks(tree, window)) blocks.set(block.from, block);
    const end = Math.min(state.doc.length, Math.max(upto, ...[...blocks.values()].map((block) => block.to + 1)));
    if (syntaxTreeAvailable(state, end)) return { blocks: [...blocks.values()], tree };
    // Markdown reparses a partial list. Grow the lookahead to avoid restarting it for every sibling.
    upto = Math.min(state.doc.length, Math.max(end, upto * 2));
  }
};

const moveListItem =
  (direction: Direction): Command =>
  (view) => {
    const { state } = view;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    const tree = ensureSyntaxTree(state, line.to, 50);
    if (!tree) return LIST_ITEM.test(line.text) || leadingWhitespace(line.text) > 0;
    const excluded = excludedLines(state);
    if (LIST_ITEM.test(line.text) && !listItemLine(tree, line, excluded)) return false;
    const parsed = parsedListBlocks(state, [{ from: line.from, to: line.to + 1 }]);
    if (!parsed) return LIST_ITEM.test(line.text) || leadingWhitespace(line.text) > 0;
    const block = parsed.blocks[0];
    if (!block) return !!listItemLine(parsed.tree, line, excluded);
    if (excluded().some((span) => head >= span.from && head < span.to)) return false;
    const structure = listStructure(state, excluded, block, parsed.tree);
    const index = structure.items.findLastIndex((item) => item.from <= head && head <= state.doc.lineAt(item.to).to);
    if (index < 0) return false;
    const item = structure.items[index]!;
    const end = state.doc.lineAt(item.to).to;
    if (state.readOnly) return true;
    if (state.selection.ranges.some((range) => range.from < item.from || range.to > end)) return false;
    const sibling = siblingIndex(structure, index, direction);
    if (sibling < 0) return true;
    const upperIndex = direction < 0 ? sibling : index;
    const lowerIndex = direction < 0 ? index : sibling;
    const upper = structure.items[upperIndex]!;
    const lower = structure.items[lowerIndex]!;
    const upperEnd = state.doc.lineAt(upper.to).to;
    const lowerEnd = state.doc.lineAt(lower.to).to;
    const gap = state.sliceDoc(upperEnd, lower.from);
    // Give the block entering the upper slot that slot's ordinal before reparsing; this preserves the list start.
    const repair = upper.ordered
      ? markerChanges(
          state,
          structure,
          new Map([[lowerIndex, `${upper.ordinal}${state.sliceDoc(lower.markerFrom, lower.markerTo).at(-1)}`]]),
        )
      : state.changes([]);
    const repairedDoc = repair.apply(state.doc);
    const upperFrom = repair.mapPos(upper.from);
    const repairedUpperEnd = repair.mapPos(upperEnd, 1);
    const lowerFrom = repair.mapPos(lower.from);
    const repairedLowerEnd = repair.mapPos(lowerEnd, 1);
    const relocation =
      direction < 0
        ? [
            { from: upperFrom, to: lowerFrom },
            { from: repairedLowerEnd, insert: gap + repairedDoc.sliceString(upperFrom, repairedUpperEnd) },
          ]
        : [
            { from: upperFrom, insert: repairedDoc.sliceString(lowerFrom, repairedLowerEnd) + gap },
            { from: repairedUpperEnd, to: repairedLowerEnd },
          ];
    const changes = repair.compose(ChangeSet.of(relocation, repairedDoc.length));
    const selection = state.selection.map(changes, direction);
    view.dispatch({ changes, selection, scrollIntoView: true, userEvent: "move.line" });
    return true;
  };

const prefixTouched = (state: EditorState, from: number, to: number, deadline: number): boolean => {
  const excluded = excludedLines(state);
  for (let number = state.doc.lineAt(from).number; number <= state.doc.lineAt(to).number; number++) {
    const line = state.doc.line(number);
    const match = LIST_ITEM.exec(line.text);
    if (!match || from >= line.from + match[0].length || to < line.from) continue;
    const remaining = deadline - performance.now();
    if (remaining <= 0) continue;
    const tree = ensureSyntaxTree(state, line.to, remaining);
    if (!tree) continue;
    if (listItemLine(tree, line, excluded)) return true;
  }
  return false;
};

/** lang-markdown's Enter already increments sibling numbers, but leaves their children at the old width. */
const continuedListColumns = (tr: Transaction, deadline: number): ChangeSet => {
  const empty = tr.state.changes([]);
  if (tr.annotation(Transaction.userEvent) !== "input") return empty;
  const numbers = new Map<number, { to: number; marker: string }>();
  let newline = false;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, insert) => {
    if (insert.toString().includes("\n")) newline = true;
    if (/^\d{1,9}$/.test(tr.startState.sliceDoc(fromA, toA)) && /^\d{1,9}$/.test(insert.toString()) && toA - fromA !== insert.length) {
      numbers.set(fromA, { to: toA, marker: insert.toString() });
    }
  });
  if (!newline || !numbers.size) return empty;
  const old = tr.startState;
  const parsed = parsedListBlocks(
    old,
    [...numbers].map(([from, { to }]) => ({ from, to })),
  );
  if (!parsed) return empty;
  const excluded = excludedLines(old);
  const specs: ChangeSpec[] = [];
  for (const block of parsed.blocks) {
    const structure = listStructure(old, excluded, block, parsed.tree);
    const markers = new Map<number, string>();
    structure.items.forEach((item, index) => {
      const number = numbers.get(item.markerFrom);
      if (item.ordered && number?.to === item.markerTo - 1)
        markers.set(index, number.marker + old.sliceDoc(item.markerTo - 1, item.markerTo));
    });
    markerChanges(old, structure, markers).iterChanges((from, to, _fromB, _toB, insert) => {
      if (![...numbers].some(([numberFrom, number]) => from >= numberFrom && to <= number.to)) specs.push({ from, to, insert });
    });
  }
  return old.changes(specs).map(tr.changes);
};

const renumber = EditorState.transactionFilter.of((tr: Transaction) => {
  if (
    !tr.docChanged ||
    tr.state.readOnly ||
    tr.annotation(ySyncAnnotation) !== undefined ||
    tr.isUserEvent("undo") ||
    tr.isUserEvent("redo")
  )
    return tr;
  const deadline = performance.now() + 50;
  const windows: ExcludedSpan[] = [];
  const oldRanges: ExcludedSpan[] = [];
  const changedRanges: ExcludedSpan[] = [];
  let structural = false;
  tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    oldRanges.push({ from: fromA, to: toA });
    changedRanges.push({ from: fromB, to: toB });
    if (
      tr.startState.sliceDoc(fromA, toA).includes("\n") ||
      tr.state.sliceDoc(fromB, toB).includes("\n") ||
      prefixTouched(tr.startState, fromA, toA, deadline) ||
      prefixTouched(tr.state, fromB, toB, deadline)
    )
      structural = true;
    const first = Math.max(1, tr.newDoc.lineAt(fromB).number - 1);
    const last = Math.min(tr.newDoc.lines, tr.newDoc.lineAt(toB).number + 1);
    windows.push({ from: tr.newDoc.line(first).from, to: tr.newDoc.line(last).to + 1 });
  });
  if (!structural) return tr;
  // When the first item of an ordered list goes, the first remaining item takes over the list's start before the
  // reparse. This also keeps a nested list that would otherwise read as paragraph text (it must start at 1) a list.
  const survivors: Array<{ markerFrom: number; markerTo: number; to: number; start: number }> = [];
  const columns = continuedListColumns(tr, deadline);
  const oldParsed = parsedListBlocks(tr.startState, oldRanges, deadline);
  if (oldParsed) {
    const excluded = excludedLines(tr.startState);
    for (const block of oldParsed.blocks) {
      const lost = new Map<number, number | null>();
      for (const item of listStructure(tr.startState, excluded, block, oldParsed.tree).items) {
        if (!item.ordered || item.start === null || lost.get(item.listFrom) === null) continue;
        const deleted =
          tr.changes.mapPos(item.markerFrom, 1, MapMode.TrackAfter) === null &&
          tr.changes.mapPos(item.markerTo, -1, MapMode.TrackBefore) === null;
        if (deleted) {
          if (!lost.has(item.listFrom)) lost.set(item.listFrom, item.start);
          continue;
        }
        const start = lost.get(item.listFrom);
        lost.set(item.listFrom, null);
        if (start === undefined || start === null) continue;
        survivors.push({
          markerFrom: columns.mapPos(tr.changes.mapPos(item.markerFrom, 1), 1),
          markerTo: columns.mapPos(tr.changes.mapPos(item.markerTo, -1), -1),
          to: columns.mapPos(tr.changes.mapPos(item.to, -1), -1),
          start,
        });
      }
    }
  }
  const shifted = columns.empty ? tr.newDoc : columns.apply(tr.newDoc);
  const restoring = EditorState.create({ doc: shifted });
  const restorable = survivors
    .filter((item) => /^\d{1,9}[.)]$/.test(restoring.sliceDoc(item.markerFrom, item.markerTo)))
    .map((item) => ({ ...item, line: shifted.lineAt(item.markerFrom).number }));
  const restored = markerChanges(
    restoring,
    { items: restorable },
    new Map(restorable.map((item, index) => [index, `${item.start}${restoring.sliceDoc(item.markerTo - 1, item.markerTo)}`])),
  );
  const prepared = columns.compose(restored);
  const state = prepared.empty
    ? tr.state
    : EditorState.create({ doc: prepared.apply(tr.newDoc), extensions: tr.state.facet(language)?.extension ?? [] });
  for (const range of [...changedRanges, ...windows]) {
    range.from = prepared.mapPos(range.from);
    range.to = prepared.mapPos(Math.min(range.to, tr.newDoc.length), 1);
  }
  const parsed = parsedListBlocks(state, windows, deadline);
  if (!parsed) return tr;
  const excluded = excludedLines(state);
  const changes: ChangeSpec[] = [];
  for (const block of parsed.blocks) {
    const structure = listStructure(state, excluded, block, parsed.tree);
    const lists = new Map<number, { from: number; to: number; start: number }>();
    for (const item of structure.items) {
      if (!item.ordered || item.start === null) continue;
      const list = lists.get(item.listFrom);
      if (list) list.to = item.to;
      else lists.set(item.listFrom, { from: item.from, to: item.to, start: item.start });
    }
    const starts = new Map<number, number>();
    for (const [listFrom, list] of lists) {
      if (changedRanges.some((range) => list.from <= range.to && list.to >= range.from)) starts.set(listFrom, list.start);
    }
    renumberChanges(state, structure, starts).iterChanges((from, to, _fromB, _toB, insert) => changes.push({ from, to, insert }));
  }
  const repair = prepared.compose(state.changes(changes));
  return repair.empty ? tr : [tr, { changes: repair, sequential: true }];
});

export const listCommandsExtension = (): Extension => [
  Prec.high(
    keymap.of([
      { key: "Mod-]", run: indentListItems },
      { key: "Mod-[", run: outdentListItems },
      { key: "Alt-ArrowUp", run: moveListItem(-1) },
      { key: "Alt-ArrowDown", run: moveListItem(1) },
      { win: "Ctrl-Shift-ArrowUp", linux: "Ctrl-Shift-ArrowUp", run: moveListItem(-1) },
      { win: "Ctrl-Shift-ArrowDown", linux: "Ctrl-Shift-ArrowDown", run: moveListItem(1) },
    ]),
  ),
  renumber,
];
