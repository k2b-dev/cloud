/** List typing, kinds, indentation, subtree moves and local number repair, shared by keys and the toolbar. */
import { completionStatus } from "@codemirror/autocomplete";
import { isolateHistory } from "@codemirror/commands";
import { ensureSyntaxTree, language, syntaxTreeAvailable } from "@codemirror/language";
import {
  Annotation,
  ChangeSet,
  type ChangeSpec,
  EditorSelection,
  EditorState,
  type Extension,
  type Line,
  MapMode,
  Prec,
  type Text,
  Transaction,
} from "@codemirror/state";
import { type Command, EditorView, keymap } from "@codemirror/view";
import type { Tree } from "@lezer/common";
import { ySyncAnnotation } from "y-codemirror.next";
import { inCode, LIST_ITEM, type ListItemLine, leadingWhitespace, listItemLine } from "./_lib/list-item-line";
import { type ExcludedSpan, excludedSpans, listStructure, markerChanges, renumberChanges, siblingIndex } from "./_lib/list-structure";
import { listStateField } from "./lists";

type Direction = 1 | -1;

/**
 * Marks a command that already restarted the numbers after an ordered item that left its list. The renumber filter
 * skips it: while the new paragraph line is still empty, Markdown reads both parts as one list and would count on.
 */
const orderedSuffixRestart = Annotation.define<boolean>();

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

const taskBox = (line: Line, item: ListItemLine) => /^[ \t]*\[[ xX]\](?:[ \t]+|$)/.exec(line.text.slice(item.content));
const textStart = (line: Line, item: ListItemLine) => {
  let start = Math.min(line.text.length, item.content + (taskBox(line, item)?.[0].length ?? 0));
  while (start < line.text.length && /[ \t]/.test(line.text[start]!)) start++;
  return line.from + start;
};
const itemKind = (line: Line, item: ListItemLine) => (taskBox(line, item) ? "task" : /^\d/.test(item.marker) ? "ordered" : "bullet");
const emptyPrefix = (line: Line, item: ListItemLine) =>
  `${line.text.slice(0, item.indent)}${item.marker} ${taskBox(line, item) ? "[ ] " : ""}`;

const firstChild = (state: EditorState, line: Line, item: ListItemLine, tree: Tree, excluded: () => readonly ExcludedSpan[]) => {
  const end = nestedEnd(state, line, item.indent);
  for (let number = line.number + 1; number <= end; number++) {
    const child = state.doc.line(number);
    const parsed = listItemLine(tree, child, excluded);
    if (parsed && parsed.indent > item.indent) return { line: child, item: parsed };
  }
  return null;
};

/** Restart the old ordered suffix before conversion can make its markers lazy paragraph text. */
const followingOrderedMarkers = (state: EditorState, removed: readonly Line[], tree: Tree, excluded: () => readonly ExcludedSpan[]) => {
  const converted = new Set(removed.map((line) => line.number));
  const markers: Array<{ line: number; to: number; markerFrom: number; markerTo: number; marker: string }> = [];
  for (const line of removed) {
    const item = listItemLine(tree, line, excluded);
    if (!item || !/^\d/.test(item.marker)) continue;
    let ordinal = 1;
    for (let number = nestedEnd(state, line, item.indent) + 1; number <= state.doc.lines; ) {
      const next = state.doc.line(number);
      if (!next.text.trim()) {
        number++;
        continue;
      }
      // Another converted sibling owns the restart after itself.
      if (converted.has(number)) break;
      const end = nestedEnd(state, next, item.indent);
      const parsed = ensureSyntaxTree(state, state.doc.line(end).to, 50);
      if (!parsed) break;
      tree = parsed;
      const sibling = listItemLine(tree, next, excluded);
      if (!sibling || sibling.indent !== item.indent || itemKind(next, sibling) !== "ordered" || !sameKind(sibling.marker, item.marker))
        break;
      markers.push({
        line: number,
        to: state.doc.line(end).to,
        markerFrom: next.from + sibling.indent,
        markerTo: next.from + sibling.indent + sibling.marker.length,
        marker: `${ordinal++}${sibling.marker.at(-1)}`,
      });
      number = end + 1;
    }
  }
  return markers;
};

/** Neighbours retain their old structure, except lines converted to paragraphs in this command. */
const separateLines = (state: EditorState, changes: ChangeSet, paragraphs: readonly number[], emptyItems: readonly number[] = []) => {
  if (!paragraphs.length && !emptyItems.length) return changes;
  const last = Math.max(...[...paragraphs, ...emptyItems].map((from) => state.doc.lineAt(from).number));
  const tree = ensureSyntaxTree(state, state.doc.line(Math.min(state.doc.lines, last + 1)).to, 50);
  if (!tree) return changes;
  const excluded = excludedLines(state);
  const converted = new Set(paragraphs.map((from) => state.doc.lineAt(from).number));
  const blanks = new Set<number>();
  const listContent = (line: Line) => {
    if (converted.has(line.number)) return false;
    if (listItemLine(tree, line, excluded)) return true;
    const pos = line.from + leadingWhitespace(line.text);
    if (excluded().some((span) => pos >= span.from && pos < span.to)) return false;
    let inside = false;
    for (let node = tree.resolveInner(pos, 1); node; ) {
      if (node.name === "Blockquote") return false;
      if (node.name === "ListItem") inside = true;
      if (!node.parent) break;
      node = node.parent;
    }
    return inside;
  };
  for (const number of converted) {
    const line = state.doc.line(number);
    const above = number > 1 ? state.doc.line(number - 1) : null;
    const below = number < state.doc.lines ? state.doc.line(number + 1) : null;
    if (above?.text.trim() && !converted.has(above.number) && listContent(above)) blanks.add(line.from);
    if (below && !converted.has(below.number) && listItemLine(tree, below, excluded)) blanks.add(below.from);
  }
  for (const from of emptyItems) {
    const line = state.doc.lineAt(from);
    const above = line.number > 1 ? state.doc.line(line.number - 1) : null;
    if (above?.text.trim() && !listContent(above)) blanks.add(line.from);
  }
  return changes.compose(
    ChangeSet.of(
      [...blanks].sort((a, b) => a - b).map((from) => ({ from: changes.mapPos(from, -1), insert: "\n" })),
      changes.newLength,
    ),
  );
};

const liftAtCaret = (view: EditorView, line: Line, item: ListItemLine, event: string) => {
  const changes = shiftChanges(view.state, -1)!;
  if (!changes.empty) {
    view.dispatch({ changes, selection: { anchor: changes.mapPos(textStart(line, item), 1) }, scrollIntoView: true, userEvent: event });
  }
  return true;
};

const paragraphAtCaret = (
  view: EditorView,
  line: Line,
  item: ListItemLine,
  event: string,
  tree: Tree,
  excluded: () => readonly ExcludedSpan[],
) => {
  const { state } = view;
  const from = textStart(line, item);
  const following = followingOrderedMarkers(state, [line], tree, excluded);
  const rewritten = markerChanges(state, { items: following }, new Map(following.map((item, index) => [index, item.marker])));
  const paragraph = ChangeSet.of({ from: rewritten.mapPos(line.from), to: rewritten.mapPos(from) }, rewritten.newLength);
  const changes = separateLines(state, rewritten.compose(paragraph), [line.from]);
  view.dispatch({
    changes,
    selection: { anchor: changes.mapPos(from, 1) },
    scrollIntoView: true,
    userEvent: event,
    annotations: orderedSuffixRestart.of(following.length > 0),
  });
  return true;
};

const singleCaret = (state: EditorState) => state.selection.ranges.length === 1 && state.selection.main.empty;

const enterListItem: Command = (view) => {
  const { state } = view;
  if (state.readOnly || !singleCaret(state) || completionStatus(state) === "active") return false;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const tree = ensureSyntaxTree(state, state.doc.line(nestedEnd(state, line, leadingWhitespace(line.text))).to, 50);
  if (!tree) return false;
  const excluded = excludedLines(state);
  const item = listItemLine(tree, line, excluded);
  if (!item) return false;
  const start = textStart(line, item);
  const child = firstChild(state, line, item, tree, excluded);
  if (!line.text.slice(start - line.from).trim()) {
    if (item.indent) return liftAtCaret(view, line, item, "input");
    return child ? true : paragraphAtCaret(view, line, item, "input", tree, excluded);
  }
  if (head <= start) {
    const prefix = emptyPrefix(line, item);
    const inserted = state.changes({ from: line.from, insert: prefix + "\n" });
    const separated = separateLines(state, inserted, [], [line.from]);
    view.dispatch({ changes: separated, selection: { anchor: separated.mapPos(start, 1) }, scrollIntoView: true, userEvent: "input" });
    return true;
  }
  if (!child) return false;
  let from = head;
  while (from > start && /\s/.test(state.sliceDoc(from - 1, from))) from--;
  const prefix = emptyPrefix(child.line, child.item);
  view.dispatch({
    changes: { from, to: head, insert: "\n" + prefix },
    selection: { anchor: from + 1 + prefix.length },
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
};

const backspaceListItem: Command = (view) => {
  const { state } = view;
  if (state.readOnly || !singleCaret(state)) return false;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const tree = ensureSyntaxTree(state, state.doc.line(nestedEnd(state, line, leadingWhitespace(line.text))).to, 50);
  if (!tree) return false;
  const excluded = excludedLines(state);
  const item = listItemLine(tree, line, excluded);
  if (item && head <= textStart(line, item)) {
    if (item.indent) return liftAtCaret(view, line, item, "delete.dedent");
    return firstChild(state, line, item, tree, excluded) ? true : paragraphAtCaret(view, line, item, "delete", tree, excluded);
  }
  if (excluded().some((span) => head >= span.from && head < span.to)) return false;
  for (let node = tree.resolveInner(head, -1); node; ) {
    if (/^ATXHeading[1-6]$/.test(node.name) && node.parent?.name === "Document") {
      const mark = node.getChild("HeaderMark");
      if (!mark) return false;
      let start = mark.to;
      while (start < line.to && /[ \t]/.test(state.sliceDoc(start, start + 1))) start++;
      if (head !== start) return false;
      view.dispatch({
        changes: { from: line.from, to: start },
        selection: { anchor: line.from },
        scrollIntoView: true,
        userEvent: "delete",
      });
      return true;
    }
    if (!node.parent) break;
    node = node.parent;
  }
  return false;
};

export const setListKind =
  (kind: "bullet" | "ordered" | "task", count = 1): Command =>
  (view) => {
    const { state } = view;
    if (state.readOnly) return false;
    const lines = count > 1 ? [state.doc.lineAt(state.selection.main.head)] : selectedLines(state);
    const last = lines.at(-1);
    if (!last) return true;
    const tree = ensureSyntaxTree(state, state.doc.line(nestedEnd(state, last, leadingWhitespace(last.text))).to, 50);
    if (!tree) return false;
    const excluded = excludedLines(state);
    const parsed = lines.map((line) => ({ line, item: listItemLine(tree, line, excluded) }));
    const toggle = count === 1 && parsed.every(({ line, item }) => item && itemKind(line, item) === kind);
    const specs: ChangeSpec[] = [];
    const markers = new Map<number, string>();
    const markerItems: Array<{ line: number; to: number; markerFrom: number; markerTo: number }> = [];
    const paragraphs: number[] = [];
    const emptyItems: number[] = [];
    const removed: Line[] = [];
    for (const { line, item } of parsed) {
      if (toggle) {
        if (item && !item.indent && !firstChild(state, line, item, tree, excluded)) {
          specs.push({ from: line.from, to: textStart(line, item) });
          paragraphs.push(line.from);
          removed.push(line);
        }
        continue;
      }
      if (item && itemKind(line, item) === kind) continue;
      if (!item) {
        if (
          (!line.text.trim() && count === 1 && !singleCaret(state)) ||
          inCode(tree, line.from + leadingWhitespace(line.text)) ||
          excluded().some((span) => line.from >= span.from && line.from < span.to)
        )
          continue;
        const from = line.from + leadingWhitespace(line.text);
        specs.push({ from, insert: kind === "ordered" ? "1. " : kind === "task" ? "- [ ] " : "- " });
        if (!line.text.trim()) emptyItems.push(line.from);
        continue;
      }
      let marker = "-";
      if (kind === "ordered") {
        const above = itemAbove(state, line, item, "previous", excluded, tree);
        const below = state.doc.line(Math.min(state.doc.lines, nestedEnd(state, line, item.indent) + 1));
        const adjacent = [above, below]
          .map((candidate) => candidate && listItemLine(tree, candidate, excluded))
          .find((candidate) => candidate?.indent === item.indent && /^\d/.test(candidate.marker));
        marker = `1${adjacent?.marker.at(-1) ?? "."}`;
      }
      if (/^\d/.test(item.marker) && !/^\d/.test(marker)) removed.push(line);
      markers.set(markerItems.length, marker);
      markerItems.push({
        line: line.number,
        to: state.doc.line(nestedEnd(state, line, item.indent)).to,
        markerFrom: line.from + item.indent,
        markerTo: line.from + item.indent + item.marker.length,
      });
      const box = taskBox(line, item);
      if (box) specs.push({ from: line.from + item.content, to: textStart(line, item) });
      if (kind === "task") specs.push({ from: line.from + item.content, insert: "[ ] " });
    }
    const following = followingOrderedMarkers(state, removed, tree, excluded);
    for (const item of following) {
      markers.set(markerItems.length, item.marker);
      markerItems.push(item);
    }
    const rewritten = markerChanges(state, { items: markerItems }, markers);
    const contentChanges: ChangeSpec[] = [];
    state
      .changes(specs)
      .iterChanges((from, to, _fromB, _toB, insert) =>
        contentChanges.push({ from: rewritten.mapPos(from, 1), to: rewritten.mapPos(to, 1), insert }),
      );
    let changes = rewritten.compose(ChangeSet.of(contentChanges, rewritten.newLength));
    changes = separateLines(state, changes, paragraphs, emptyItems);
    let firstHead: number | null = null;
    if (count > 1) {
      const { line, item } = parsed[0]!;
      if (!item && !specs.length) return false;
      const indent = item?.indent ?? leadingWhitespace(line.text);
      const marker = markers.get(0) ?? item?.marker ?? (kind === "ordered" ? "1." : "-");
      const siblingMarker = /^\d/.test(marker) ? `1${marker.at(-1)}` : marker;
      const prefix = `${line.text.slice(0, indent)}${siblingMarker} ${kind === "task" ? "[ ] " : ""}`;
      const end = state.doc.line(nestedEnd(state, line, indent)).to;
      const siblings = ChangeSet.of({ from: changes.mapPos(end, 1), insert: ("\n" + prefix).repeat(count - 1) }, changes.newLength);
      firstHead = siblings.mapPos(changes.mapPos(item ? textStart(line, item) : line.from + indent, 1), -1);
      changes = changes.compose(siblings);
    }
    if (!changes.empty) {
      const selection = firstHead === null ? state.selection.map(changes, 1) : EditorSelection.single(firstHead);
      view.dispatch({
        changes,
        selection,
        scrollIntoView: true,
        userEvent: "input",
        annotations: orderedSuffixRestart.of(following.length > 0),
      });
    }
    return true;
  };

export const toggleTaskAtCaret: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
  const line = state.doc.lineAt(state.selection.main.head);
  const tree = ensureSyntaxTree(state, line.to, 50);
  const item = tree && listItemLine(tree, line, excludedLines(state));
  const box = item && taskBox(line, item);
  if (!item || !box) return false;
  const from = line.from + item.content + box[0].indexOf("[") + 1;
  view.dispatch({ changes: { from, to: from + 1, insert: state.sliceDoc(from, from + 1) === " " ? "x" : " " }, userEvent: "input" });
  return true;
};

const android = typeof navigator === "object" && /Android\b/.test(navigator.userAgent);
const typedTask = EditorView.inputHandler.of((view, from, to, text, insert) => {
  const { state } = view;
  if (
    (android ? view.composing : view.compositionStarted) ||
    state.readOnly ||
    text !== " " ||
    from !== to ||
    !singleCaret(state) ||
    from !== state.selection.main.head
  )
    return false;
  const line = state.doc.lineAt(from);
  const prefix = /^( *)(?:(?:[-*+]|\d{1,9}[.)]) +)?\[(?: )?\]$/.exec(state.sliceDoc(line.from, from));
  const marker = prefix && LIST_ITEM.exec(prefix[0]);
  // `- [ ] ` is already a task; converting it again would only add an empty undo step.
  if (!prefix || (marker && prefix[0].endsWith("[ ]"))) return false;
  const tree = ensureSyntaxTree(state, line.to, 50);
  if (!tree || inCode(tree, line.from + prefix[1]!.length) || excludedLines(state)().some((span) => from >= span.from && from < span.to))
    return false;
  // The typed space is ordinary input; undoing the separate conversion keeps it.
  view.dispatch(insert());
  const replacement = marker ? `${marker[0]}[ ] ` : `${prefix[1]}- [ ] `;
  const empty = !line.text.slice(from - line.from).trim();
  const changes = separateLines(
    view.state,
    view.state.changes({ from: line.from, to: from + 1, insert: replacement }),
    [],
    empty ? [line.from] : [],
  );
  view.dispatch({
    changes,
    selection: { anchor: changes.mapPos(from + 1, 1) },
    scrollIntoView: true,
    userEvent: "input",
    annotations: isolateHistory.of("before"),
  });
  return true;
});

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

/** Empty ordered children can still parse as continuation text until someone types. Repair their source list too. */
const unparsedNumbers = (
  state: EditorState,
  blocks: readonly ExcludedSpan[],
  ranges: readonly ExcludedSpan[],
  tree: Tree,
  deadline: number,
): ChangeSet => {
  const excluded = excludedLines(state);
  const items: Array<{ line: number; to: number; markerFrom: number; markerTo: number }> = [];
  const markers = new Map<number, string>();
  for (const block of blocks) {
    const parsedLines = new Set(listStructure(state, excluded, block, tree).items.map((item) => item.line));
    const emptySourceOnly = (line: Line, item: ListItemLine) =>
      !parsedLines.has(line.number) && !line.text.slice(textStart(line, item) - line.from).trim();
    const source = [];
    for (let number = state.doc.lineAt(block.from).number; number <= state.doc.lineAt(block.to).number; number++) {
      const line = state.doc.line(number);
      const item = listItemLine(tree, line, excluded);
      if (item && /^\d/.test(item.marker)) source.push({ line, item });
    }
    if (!source.some(({ line, item }) => emptySourceOnly(line, item))) continue;
    for (const { line, item } of source) {
      if (performance.now() >= deadline) return state.changes([]);
      const number = line.number;
      let first = line;
      let empty = emptySourceOnly(line, item);
      for (
        let above = itemAbove(state, first, item, "sibling", excluded, tree);
        above;
        above = itemAbove(state, first, item, "sibling", excluded, tree)
      ) {
        first = above;
        if (emptySourceOnly(first, listItemLine(tree, first, excluded)!)) empty = true;
      }
      let end = nestedEnd(state, line, item.indent);
      for (let next = end + 1; next <= state.doc.lines; ) {
        const sibling = state.doc.line(next);
        const parsed = listItemLine(tree, sibling, excluded);
        if (!parsed || parsed.indent !== item.indent || !sameKind(parsed.marker, item.marker)) break;
        if (emptySourceOnly(sibling, parsed)) empty = true;
        end = nestedEnd(state, sibling, parsed.indent);
        next = end + 1;
      }
      if (!empty) continue;
      if (!ranges.some((range) => first.from <= range.to && state.doc.line(end).to >= range.from)) continue;
      const marker = `${ordinalAt(state, line, excluded, tree)}${item.marker.at(-1)}`;
      if (marker === item.marker) continue;
      markers.set(items.length, marker);
      items.push({
        line: number,
        to: state.doc.line(nestedEnd(state, line, item.indent)).to,
        markerFrom: line.from + item.indent,
        markerTo: line.from + item.indent + item.marker.length,
      });
    }
  }
  return markerChanges(state, { items }, markers);
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
    tr.annotation(orderedSuffixRestart) ||
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
  let prepared = columns.compose(restored);
  let state = prepared.empty
    ? tr.state
    : EditorState.create({ doc: prepared.apply(tr.newDoc), extensions: tr.state.facet(language)?.extension ?? [] });
  for (const range of [...changedRanges, ...windows]) {
    range.from = prepared.mapPos(range.from);
    range.to = prepared.mapPos(Math.min(range.to, tr.newDoc.length), 1);
  }
  let parsed = parsedListBlocks(state, windows, deadline);
  if (!parsed) return tr;
  const sourceRepair = unparsedNumbers(state, parsed.blocks, changedRanges, parsed.tree, deadline);
  if (!sourceRepair.empty) {
    prepared = prepared.compose(sourceRepair);
    state = EditorState.create({ doc: sourceRepair.apply(state.doc), extensions: state.facet(language)?.extension ?? [] });
    for (const range of [...changedRanges, ...windows]) {
      range.from = sourceRepair.mapPos(range.from);
      range.to = sourceRepair.mapPos(Math.min(range.to, sourceRepair.length), 1);
    }
    parsed = parsedListBlocks(state, windows, deadline);
    if (!parsed) return [tr, { changes: prepared, sequential: true }];
  }
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
  Prec.highest(
    keymap.of([
      { key: "Enter", run: enterListItem },
      { key: "Backspace", run: backspaceListItem },
      { key: "Mod-Enter", run: toggleTaskAtCaret },
      { key: "Mod-Shift-7", run: setListKind("ordered") },
      { key: "Mod-Shift-8", run: setListKind("bullet") },
      { key: "Mod-Shift-9", run: setListKind("task") },
    ]),
  ),
  typedTask,
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
