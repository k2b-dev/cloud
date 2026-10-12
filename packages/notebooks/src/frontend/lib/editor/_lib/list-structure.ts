/**
 * The list items of a note as Markdown parses them: real nesting depth, the
 * number Book shows, and the source ranges of markers and content. Editor
 * display, renumbering, moving items and list-aware paste share this model.
 */
import { syntaxTree } from "@codemirror/language";
import type { ChangeSet, ChangeSpec, EditorState } from "@codemirror/state";
import type { Tree } from "@lezer/common";
import { extractDataBlocks } from "../../../../lib/named-blocks";
import { extractNotebookDirectiveRanges } from "../../../../lib/query-blocks";

export type ListItemKind = "bullet" | "ordered" | "task";
export type ListItem = {
  /** 1-based marker line and its start position. */
  line: number;
  from: number;
  /** End of the ListItem node, including its descendants. */
  to: number;
  depth: number;
  orderedDepth: number;
  kind: ListItemKind;
  ordered: boolean;
  start: number | null;
  ordinal: number | null;
  checked: boolean;
  markerFrom: number;
  markerTo: number;
  taskFrom: number | null;
  taskTo: number | null;
  contentFrom: number;
  parent: number;
  /** Source identity of the containing list, including separate lists of the same kind. */
  listFrom: number;
  /** Index one past the last descendant. */
  subtreeEnd: number;
};
export type ListStructure = { items: readonly ListItem[] };
export type ExcludedSpan = { from: number; to: number };

/** Full source scan; callers cache these spans independently of parser progress. */
export const excludedSpans = (state: EditorState): ExcludedSpan[] => {
  const markdown = state.doc.toString();
  return [
    ...extractDataBlocks(markdown).map((block) => ({ from: block.blockStart, to: block.blockEnd })),
    ...extractNotebookDirectiveRanges(markdown).map(({ from, to }) => ({ from, to })),
  ];
};

/** Items outside quotes, data blocks and directives. Optional ranges cover whole top-level list blocks; exclusions are read only when a list exists. */
export const listStructure = (
  state: EditorState,
  excludedSpans: () => readonly ExcludedSpan[],
  range?: ExcludedSpan,
  tree: Tree = syntaxTree(state),
): ListStructure => {
  const items: ListItem[] = [];
  const parents: Array<{ from: number; index: number }> = [];
  const lists: Array<{ ordered: boolean; start: number | null; index: number }> = [];
  tree.iterate({
    from: range?.from,
    to: range?.to,
    enter(ref) {
      if (ref.name === "Blockquote") return false;
      const node = ref.node;
      if (ref.name === "BulletList" || ref.name === "OrderedList") {
        if (range && (ref.to <= range.from || ref.from >= range.to)) return false;
        const ordered = ref.name === "OrderedList";
        const mark = node.getChild("ListItem")?.getChild("ListMark");
        lists.push({ ordered, start: ordered && mark ? Number.parseInt(state.sliceDoc(mark.from, mark.to), 10) : null, index: 0 });
      }
      if (ref.name !== "ListItem" || !["BulletList", "OrderedList"].includes(node.parent?.name ?? "")) return;
      const list = lists.at(-1);
      const mark = node.getChild("ListMark");
      if (!list || !mark) return false;
      const ordinal = list.start === null ? null : list.start + list.index;
      list.index++;
      const line = state.doc.lineAt(mark.from);
      if (items.at(-1)?.line === line.number || excludedSpans().some((span) => mark.from >= span.from && mark.from < span.to)) return false;
      const task = node.getChild("Task")?.getChild("TaskMarker");
      let contentFrom = task?.to ?? mark.to;
      while (contentFrom < line.to && /[ \t]/.test(state.sliceDoc(contentFrom, contentFrom + 1))) contentFrom++;
      const parent = parents.at(-1)?.index ?? -1;
      const ancestor = items[parent];
      const index = items.length;
      items.push({
        line: line.number,
        from: line.from,
        to: node.to,
        depth: parents.length,
        orderedDepth: ancestor ? ancestor.orderedDepth + Number(ancestor.ordered) : 0,
        kind: task ? "task" : list.ordered ? "ordered" : "bullet",
        ordered: list.ordered,
        start: list.start,
        ordinal,
        checked: task ? state.sliceDoc(task.from, task.to) !== "[ ]" : false,
        markerFrom: mark.from,
        markerTo: mark.to,
        taskFrom: task?.from ?? null,
        taskTo: task?.to ?? null,
        contentFrom,
        parent,
        listFrom: node.parent!.from,
        subtreeEnd: index + 1,
      });
      parents.push({ from: node.from, index });
    },
    leave(ref) {
      if (ref.name === "BulletList" || ref.name === "OrderedList") lists.pop();
      if (ref.name === "ListItem" && parents.at(-1)?.from === ref.from) {
        const parent = parents.pop();
        if (parent) items[parent.index]!.subtreeEnd = items.length;
      }
    },
  });
  return { items };
};

/** Rewrite markers and shift continuation text and children by the width delta. Source-only items also cover empty, not-yet-parsed items. */
export const markerChanges = (
  state: EditorState,
  structure: { items: readonly Pick<ListItem, "line" | "to" | "markerFrom" | "markerTo">[] },
  markers: ReadonlyMap<number, string>,
): ChangeSet => {
  const changes: ChangeSpec[] = [];
  const deltas = new Map<number, number>();
  for (const [index, marker] of markers) {
    const item = structure.items[index]!;
    if (state.sliceDoc(item.markerFrom, item.markerTo) === marker) continue;
    changes.push({ from: item.markerFrom, to: item.markerTo, insert: marker });
    const delta = marker.length - (item.markerTo - item.markerFrom);
    if (!delta) continue;
    for (let number = item.line + 1; number <= state.doc.lineAt(item.to).number; number++) {
      const line = state.doc.line(number);
      if (line.text.trim()) deltas.set(number, (deltas.get(number) ?? 0) + delta);
    }
  }
  for (const [number, delta] of deltas) {
    const line = state.doc.line(number);
    if (delta > 0) changes.push({ from: line.from, insert: " ".repeat(delta) });
    else if (delta < 0) changes.push({ from: line.from, to: line.from + Math.min(-delta, /^ */.exec(line.text)![0].length) });
  }
  return state.changes(changes);
};

/** Repair the written numbers to the ordinals Book displays, preserving each list's start and delimiter. */
export const renumberChanges = (state: EditorState, structure: ListStructure): ChangeSet => {
  const markers = new Map<number, string>();
  structure.items.forEach((item, index) => {
    if (!item.ordered) return;
    const written = state.sliceDoc(item.markerFrom, item.markerTo);
    const marker = `${item.ordinal}${written.at(-1)}`;
    if (written !== marker) markers.set(index, marker);
  });
  return markerChanges(state, structure, markers);
};

export const siblingIndex = (structure: ListStructure, index: number, direction: 1 | -1): number => {
  const item = structure.items[index]!;
  for (let next = direction > 0 ? item.subtreeEnd : index - 1; next >= 0 && next < structure.items.length; next += direction) {
    const candidate = structure.items[next]!;
    if (candidate.depth < item.depth) break;
    if (candidate.depth === item.depth) return candidate.parent === item.parent && candidate.listFrom === item.listFrom ? next : -1;
  }
  return -1;
};

/** Binary search for the item whose marker is on this line. */
export const listItemAtLine = (structure: ListStructure, line: number): number => {
  let low = 0;
  let high = structure.items.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const candidate = structure.items[middle]!;
    if (candidate.line === line) return middle;
    if (candidate.line < line) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
};

const romanDigits: readonly (readonly [number, string])[] = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
];

/** Labels cycle through 1., a., i. for six ordered levels; deeper levels keep roman like Book and the PDF, with CSS's decimal fallback. */
export const orderedLabel = (ordinal: number, orderedDepth: number): string => {
  const style = Math.min(orderedDepth, 5) % 3;
  let label = "";
  if (style === 1 && ordinal >= 1) {
    for (let n = ordinal; n > 0; n = Math.floor((n - 1) / 26)) label = String.fromCharCode(97 + ((n - 1) % 26)) + label;
  } else if (style === 2 && ordinal >= 1 && ordinal <= 3999) {
    let n = ordinal;
    for (const [value, digit] of romanDigits) {
      while (n >= value) {
        label += digit;
        n -= value;
      }
    }
  } else label = String(ordinal);
  return `${label}.`;
};
