/** Toolbar and keyboard commands. Each one is a plain Markdown edit of the selection. */
import { EditorSelection, type EditorState, Facet, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/** Insertion text follows the editor's inherited locale, including keyboard commands. */
export const formatLabels = Facet.define<
  { link: string; column: (column: number) => string },
  { link: string; column: (column: number) => string }
>({
  combine: (values) => values[0] ?? { link: "Link", column: (column) => `Column ${column}` },
});

export type InlineFormat = "bold" | "italic" | "code" | "strike" | "link";
/** Pure transaction spec, also used when a missing table cell must be materialized atomically. */
export const inlineFormat = (state: EditorState, name: InlineFormat): TransactionSpec => {
  if (name === "link") {
    const { from, to } = state.selection.main;
    const label = state.sliceDoc(from, to) || state.facet(formatLabels).link;
    return {
      changes: { from, to, insert: `[${label}](https://)` },
      selection: { anchor: from + label.length + 3, head: from + label.length + 11 },
      userEvent: "input.format",
    };
  }
  const marker = { bold: "**", italic: "*", code: "`", strike: "~~" }[name];
  return {
    ...state.changeByRange((range) => {
      const text = state.sliceDoc(range.from, range.to);
      const before = state.sliceDoc(Math.max(0, range.from - marker.length), range.from);
      const after = state.sliceDoc(range.to, Math.min(state.doc.length, range.to + marker.length));
      const italicBoundary =
        name !== "italic" ||
        ((/\*+$/.exec(state.sliceDoc(state.doc.lineAt(range.from).from, range.from))?.[0].length ?? 0) % 2 === 1 &&
          (/^\*+/.exec(state.sliceDoc(range.to, state.doc.lineAt(range.to).to))?.[0].length ?? 0) % 2 === 1);
      if (before === marker && after === marker && italicBoundary)
        return {
          changes: [
            { from: range.from - marker.length, to: range.from },
            { from: range.to, to: range.to + marker.length },
          ],
          range: EditorSelection.range(range.from - marker.length, range.to - marker.length),
        };
      return {
        changes: { from: range.from, to: range.to, insert: `${marker}${text}${marker}` },
        range: EditorSelection.range(range.from + marker.length, range.to + marker.length),
      };
    }),
    userEvent: "input.format",
  };
};
const inlineCommand = (name: InlineFormat) => (view: EditorView) => {
  if (view.state.readOnly) return false;
  view.dispatch(inlineFormat(view.state, name));
  view.focus();
  return true;
};

const linePrefix = (pattern: RegExp, prefix: (state: EditorState, n: number) => string) => (view: EditorView) => {
  if (view.state.readOnly) return false;
  const { state } = view;
  const lines = new Set<number>();
  for (const r of state.selection.ranges)
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) lines.add(n);
  const all = [...lines].every((n) => pattern.test(state.doc.line(n).text));
  const changes = [...lines].map((n) => {
    const line = state.doc.line(n);
    const m = pattern.exec(line.text);
    return all && m ? { from: line.from, to: line.from + m[0].length } : { from: line.from, insert: prefix(state, n) };
  });
  view.dispatch({ changes, userEvent: "input.format" });
  view.focus();
  return true;
};

const heading = (level: number) => (view: EditorView) => {
  if (view.state.readOnly) return false;
  const { state } = view;
  const numbers = new Set<number>();
  for (const range of state.selection.ranges)
    for (let n = state.doc.lineAt(range.from).number; n <= state.doc.lineAt(range.to).number; n++) numbers.add(n);
  const prefix = `${"#".repeat(level)} `;
  const lines = [...numbers].sort((a, b) => a - b).map((number) => state.doc.line(number));
  const remove = lines.every((line) => line.text.startsWith(prefix));
  view.dispatch({
    changes: lines.map((line) => ({
      from: line.from,
      to: line.from + (/^#{1,6} /.exec(line.text)?.[0].length ?? 0),
      insert: remove ? "" : prefix,
    })),
    userEvent: "input.format",
  });
  view.focus();
  return true;
};

export const commands = {
  bold: inlineCommand("bold"),
  italic: inlineCommand("italic"),
  code: inlineCommand("code"),
  strike: inlineCommand("strike"),
  heading: heading(2),
  heading1: heading(1),
  heading2: heading(2),
  heading3: heading(3),
  codeBlock: (view: EditorView) => {
    if (view.state.readOnly) return false;
    const { state } = view;
    const from = state.doc.lineAt(state.selection.main.from).from;
    const to = state.doc.lineAt(state.selection.main.to).to;
    const text = state.sliceDoc(from, to);
    let fenceLength = 3;
    for (const match of text.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
    const fence = "`".repeat(fenceLength);
    const lead = from > 0 && state.doc.lineAt(from - 1).length ? "\n" : "";
    const tail = to < state.doc.length && state.doc.lineAt(to + 1).length ? "\n" : "";
    const start = from + lead.length + fence.length + 1;
    view.dispatch({
      changes: { from, to, insert: `${lead}${fence}\n${text}\n${fence}${tail}` },
      selection: { anchor: start, head: start + text.length },
      userEvent: "input.format",
    });
    view.focus();
    return true;
  },
  bulletList: linePrefix(/^\s*[-*] /, () => "- "),
  orderedList: linePrefix(/^\s*\d+\. /, () => "1. "),
  quote: linePrefix(/^> ?/, () => "> "),
  link: inlineCommand("link"),
  table: (view: EditorView) => {
    if (view.state.readOnly) return false;
    const { from } = view.state.selection.main;
    const line = view.state.doc.lineAt(from);
    const lead = line.length ? "\n\n" : "";
    const labels = view.state.facet(formatLabels);
    const first = labels.column(1);
    const insert = `${lead}| ${first} | ${labels.column(2)} |\n| --- | --- |\n|   |   |\n`;
    const anchor = line.to + lead.length + 2;
    view.dispatch({ changes: { from: line.to, insert }, selection: { anchor, head: anchor + first.length }, userEvent: "input.format" });
    view.focus();
    queueMicrotask(() => {
      if (!view.dom.isConnected) return;
      const table = [...view.contentDOM.querySelectorAll<HTMLElement>(".ste-table")].find(
        (element) => view.posAtDOM(element) === line.to + lead.length,
      );
      const cell = table?.querySelector<HTMLElement>('.ste-cell[data-r="0"][data-c="0"]');
      if (!cell) return;
      cell.focus();
      const selection = cell.ownerDocument.getSelection();
      const range = cell.ownerDocument.createRange();
      range.selectNodeContents(cell);
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    return true;
  },
  rule: (view: EditorView) => {
    if (view.state.readOnly) return false;
    const line = view.state.doc.lineAt(view.state.selection.main.from);
    const previousHasText = line.number > 1 && view.state.doc.line(line.number - 1).text.trim().length > 0;
    const lead = line.length ? "\n\n" : previousHasText ? "\n" : "";
    view.dispatch({ changes: { from: line.to, insert: `${lead}---\n` }, userEvent: "input.format" });
    view.focus();
    return true;
  },
};
