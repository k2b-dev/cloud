import { isolateHistory } from "@codemirror/commands";
import { ensureSyntaxTree } from "@codemirror/language";
import { type ChangeSet, type ChangeSpec, EditorSelection, type EditorState, type SelectionRange } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { prompts } from "@k2b/ui";
import type { Tree } from "@lezer/common";
import { MARK_REGEX, TAG_REGEX } from "../../../lib/editor/_lib/inline-syntax";
import { inCode } from "../../../lib/editor/_lib/list-item-line";
import { excludedSpans } from "../../../lib/editor/_lib/list-structure";
import { buildDataBlockTemplate, dataBlockRefSelection } from "../../../lib/editor/data-block-template";
import { listIndentAvailability, listKindAt } from "../../../lib/editor/list-commands";
import { notebookWorkspaceMessages } from "../../messages";
import { openNoteLinkPrompt } from "../search/openNoteSearchPrompt";

/**
 * Editor-level actions used by the toolbar AND the slash-command palette.
 *
 * Pure DOM-aware operations on a `EditorView` — no SolidJS state. Some
 * actions open prompts (`prompts.form`, `openNoteLinkPrompt`) which are
 * async; the editor stays non-modal while a prompt is open, so callers
 * should treat the editor's selection as a snapshot from before the prompt.
 */

// ==========================
// Inline marks
// ==========================

export type InlineMark = "bold" | "italic" | "strikethrough" | "highlight" | "code";

const inlineMarks = {
  bold: { node: "StrongEmphasis", delimiter: "**" },
  italic: { node: "Emphasis", delimiter: "*" },
  strikethrough: { node: "Strikethrough", delimiter: "~~" },
  highlight: { node: "Highlight", delimiter: "==" },
  code: { node: "InlineCode", delimiter: "`" },
};

/** Same parse budget as the list commands; a range that cannot be parsed in time is left alone. */
const PARSE_BUDGET_MS = 50;
const parsedTree = (state: EditorState, pos: number) => ensureSyntaxTree(state, state.doc.lineAt(pos).to, PARSE_BUDGET_MS);
const delimiterMarks = new Set(["EmphasisMark", "StrikethroughMark", "CodeMark"]);

/** True when `pos` sits inside a `#tag` or right before its `#`, where a mark would break the tag. */
const breaksTag = (state: EditorState, pos: number, opening: boolean) => {
  const line = state.doc.lineAt(pos);
  for (const match of line.text.matchAll(TAG_REGEX)) {
    const start = line.from + match.index + match[1]!.length;
    const end = start + 1 + match[2]!.length;
    if ((opening ? start <= pos : start < pos) && pos < end) return true;
  }
  return false;
};

const trimmedRange = (state: EditorState) => {
  const selection = state.selection.main;
  const selected = state.sliceDoc(selection.from, selection.to);
  const from = selection.from + selected.length - selected.trimStart().length;
  return { from, to: from + selected.trim().length };
};

const highlightBlocked = (state: EditorState, tree: Tree, from: number, to: number) => {
  let blocked = false;
  tree.iterate({
    from,
    to,
    enter(node) {
      if (["InlineCode", "FencedCode", "CodeBlock", "URL"].includes(node.name) && node.from < to && node.to > from) blocked = true;
    },
  });
  return blocked || breaksTag(state, from, true) || breaksTag(state, to, false);
};

const markSpans = (state: EditorState, tree: Tree, mark: InlineMark, from: number, to: number) => {
  const found: { from: number; to: number; opening: { from: number; to: number }; closing: { from: number; to: number } }[] = [];
  if (mark === "highlight") {
    for (let number = state.doc.lineAt(from).number; number <= state.doc.lineAt(to).number; number++) {
      const line = state.doc.line(number);
      for (const match of line.text.matchAll(MARK_REGEX)) {
        const start = line.from + match.index;
        const end = start + match[0].length;
        if (start <= to && end >= from && !highlightBlocked(state, tree, start, end))
          found.push({ from: start, to: end, opening: { from: start, to: start + 2 }, closing: { from: end - 2, to: end } });
      }
    }
  } else {
    tree.iterate({
      from,
      to,
      enter: ({ name, node }) => {
        if (name === inlineMarks[mark].node && node.firstChild && node.lastChild)
          found.push({ from: node.from, to: node.to, opening: node.firstChild, closing: node.lastChild });
      },
    });
  }
  return found;
};

const containingMark = (state: EditorState, tree: Tree, mark: InlineMark, from: number, to: number) =>
  markSpans(state, tree, mark, from, to).findLast((span) => span.opening.to <= from && to <= span.closing.from);

const headingAt = (state: EditorState, tree: Tree) => {
  const line = state.doc.lineAt(state.selection.main.head);
  let level = 0;
  tree.iterate({
    from: line.from,
    to: line.to,
    enter(node) {
      if (/^ATXHeading[1-6]$/.test(node.name)) level = Number(node.name.at(-1));
    },
  });
  return level;
};

export type CaretFormat = ReturnType<typeof caretFormat>;

/** Lets a signal skip updates while the caret moves within the same formats. */
export const sameCaretFormat = (a: CaretFormat, b: CaretFormat) =>
  a.bold === b.bold &&
  a.italic === b.italic &&
  a.strikethrough === b.strikethrough &&
  a.highlight === b.highlight &&
  a.list === b.list &&
  a.heading === b.heading &&
  a.indent === b.indent &&
  a.outdent === b.outdent;

/** Formats at the selection; a mark or list kind counts exactly when its toggle would remove it. */
export const caretFormat = (state: EditorState) => {
  const inactive = {
    bold: false,
    italic: false,
    strikethrough: false,
    highlight: false,
    list: null,
    heading: 0,
    indent: false,
    outdent: false,
  };
  const { from, to } = trimmedRange(state);
  const tree = parsedTree(state, Math.max(to, ...state.selection.ranges.map((range) => range.to)));
  if (!tree) return inactive;
  const pressed = (mark: InlineMark) => (state.selection.main.empty || from < to) && !!containingMark(state, tree, mark, from, to);
  return {
    bold: pressed("bold"),
    italic: pressed("italic"),
    strikethrough: pressed("strikethrough"),
    highlight: pressed("highlight"),
    list: listKindAt(state),
    heading: headingAt(state, tree),
    ...listIndentAvailability(state),
  };
};

/**
 * Toggle an inline Markdown mark on the selection, or on the word at the
 * caret. Whitespace at the selection edges stays outside the mark.
 *
 * - Inside a span of the same kind (also `_x_` or `__x__`), the span's marks
 *   are removed. A selection strictly inside the span's text is split out of
 *   it instead, so only the selected part loses the mark. A caret on the
 *   span's marks next to a word formats that word instead.
 * - Otherwise the mark wraps the range and absorbs same-kind spans it
 *   overlaps or touches.
 *
 * Highlight uses the same single-line `==text==` syntax as the preview.
 * Every inserted mark must parse as Markdown markup (or match MARK_REGEX); otherwise nothing
 * changes. This covers code, link targets, ranges that cross blocks or other
 * spans, and runs that CommonMark cannot close. The command also does
 * nothing inside a `#tag` or before the syntax tree covers the range. Only
 * the marks change, in one transaction that is its own undo step, so a
 * peer's concurrent edit inside the text survives.
 */
export const toggleInlineMark = (view: EditorView, mark: InlineMark): void => {
  const { state } = view;
  const selection = state.selection.main;
  let { from, to } = trimmedRange(state);
  if (!selection.empty && from === to) return;
  const tree = parsedTree(state, to);
  if (!tree || (mark === "highlight" && state.doc.lineAt(from).number !== state.doc.lineAt(to).number)) return;
  const { node: nodeType, delimiter } = inlineMarks[mark];
  const spans = (from: number, to: number) => markSpans(state, tree, mark, from, to);
  const edits: ChangeSpec[] = [];
  const inserts: { at: number; text: string }[] = [];
  const removeMarks = ({ opening, closing }: { opening: { from: number; to: number }; closing: { from: number; to: number } }) => {
    edits.push({ from: opening.from, to: opening.to }, { from: closing.from, to: closing.to });
  };
  const insert = (at: number, text: string) => {
    edits.push({ from: at, insert: text });
    inserts.push({ at, text });
  };

  /** Dispatch unless an inserted delimiter stays literal text, or a wrap does not produce a span. */
  const apply = (selectionAfter: (changes: ChangeSet) => SelectionRange, wrapped?: { from: number; to: number }) => {
    const changes = state.changes(edits);
    if (inserts.length > 0) {
      const next = state.update({ changes }).state;
      const placed = inserts.map(({ at, text }) => ({ from: changes.mapPos(at, -1), to: changes.mapPos(at, -1) + text.length }));
      const nextTree = parsedTree(next, Math.max(...placed.map((range) => range.to)));
      if (!nextTree) return;
      const marks: { from: number; to: number }[] = [];
      const nodes: { from: number; to: number }[] = [];
      if (mark === "highlight") {
        for (const span of markSpans(
          next,
          nextTree,
          mark,
          Math.min(...placed.map((range) => range.from)),
          Math.max(...placed.map((range) => range.to)),
        )) {
          marks.push(span.opening, span.closing);
          nodes.push(span);
        }
      }
      nextTree.iterate({
        from: Math.min(...placed.map((range) => range.from)),
        to: Math.max(...placed.map((range) => range.to)),
        enter: (node) => {
          if (delimiterMarks.has(node.name)) marks.push({ from: node.from, to: node.to });
          if (node.name === nodeType) nodes.push({ from: node.from, to: node.to });
        },
      });
      const isMarkup = (pos: number) => marks.some((range) => range.from <= pos && pos < range.to);
      for (const range of placed) {
        for (let pos = range.from; pos < range.to; pos++) if (!isMarkup(pos)) return;
      }
      if (wrapped) {
        const a = changes.mapPos(wrapped.from, -1);
        const b = changes.mapPos(wrapped.to, 1);
        const span = nodes.some((node) =>
          mark === "highlight"
            ? node.from === a && node.to === b
            : a <= node.from && node.to <= b && node.from <= a + delimiter.length && node.to >= b - delimiter.length,
        );
        if (!span) return;
      }
    }
    view.dispatch({ changes, selection: selectionAfter(changes), annotations: isolateHistory.of("full") });
    view.focus();
  };
  const mapSelection = (changes: ChangeSet) =>
    EditorSelection.range(changes.mapPos(selection.anchor, 1), changes.mapPos(selection.head, 1));

  // Spans are visited outside in, so the last containing one is the innermost.
  const containing = spans(from, to).findLast((span) => span.from <= from && to <= span.to);
  const word = selection.empty ? state.wordAt(selection.head) : null;
  if (containing) {
    const { opening, closing } = containing;
    if (!selection.empty && (from > opening.to || to < closing.from)) {
      // Split the selected text out of the span; an empty side drops its mark.
      const text = state.sliceDoc(opening.from, opening.to);
      const before = state.sliceDoc(opening.to, Math.max(opening.to, from)).trimEnd();
      const after = state.sliceDoc(Math.min(to, closing.from), closing.from);
      if (before) insert(opening.to + before.length, text);
      else edits.push({ from: opening.from, to: opening.to });
      if (after.trim()) insert(closing.from - after.trimStart().length, text);
      else edits.push({ from: closing.from, to: closing.to });
      const forward = selection.anchor <= selection.head;
      return apply((changes) => {
        const start = changes.mapPos(from, 1);
        const end = changes.mapPos(to, -1);
        return forward ? EditorSelection.range(start, end) : EditorSelection.range(end, start);
      });
    }
    const caretOnMarksNextToWord = word && (from < opening.to || to > closing.from);
    if (!caretOnMarksNextToWord) {
      removeMarks(containing);
      return apply(mapSelection);
    }
  }

  if (selection.empty) {
    if (!word) return;
    ({ from, to } = word);
  }
  for (const node of spans(from, to)) {
    removeMarks(node);
    from = Math.min(from, node.from);
    to = Math.max(to, node.to);
  }
  if (breaksTag(state, from, true) || breaksTag(state, to, false)) return;
  if (mark === "highlight" && highlightBlocked(state, tree, from, to)) return;
  insert(from, delimiter);
  insert(to, delimiter);
  apply(
    (changes) => {
      const start = changes.mapPos(from, -1) + delimiter.length;
      const end = changes.mapPos(to, 1) - delimiter.length;
      if (selection.empty) return EditorSelection.cursor(Math.max(start, Math.min(end, changes.mapPos(selection.head, 1))));
      return selection.anchor <= selection.head ? EditorSelection.range(start, end) : EditorSelection.range(end, start);
    },
    { from, to },
  );
};

// ==========================
// Headings
// ==========================

type HeadingLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Make the caret's line a heading of `level`, or normal text for 0. The `#` marks go after quote and list markers,
 * so the line stays in its quote or list, and the caret stays in the text. Code and data blocks stay unchanged.
 */
export const setHeadingLevel = (view: EditorView, level: HeadingLevel): void => {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const tree = parsedTree(state, line.to);
  if (!tree) return;
  const leading = /^[ \t]*(?:(?:>[ \t]*|(?:[-+*]|\d{1,9}[.)])[ \t]+)[ \t]*)*/.exec(line.text)![0];
  const from = line.from + leading.length;
  if (inCode(tree, from) || excludedSpans(state).some((span) => from >= span.from && from < span.to)) return;
  const heading = /^(#{1,6})(?:[ \t]+|$)/.exec(line.text.slice(leading.length));
  const prefix = level ? `${"#".repeat(level)} ` : "";
  const changes = state.changes({ from, to: from + (heading?.[0].length ?? 0), insert: prefix });
  view.dispatch({ changes, selection: state.selection.map(changes, 1), annotations: isolateHistory.of("full") });
  view.focus();
};

/** The heading shortcuts: the line's own level again turns it back into normal text. */
export const toggleHeadingLevel = (view: EditorView, level: HeadingLevel): void => {
  const tree = parsedTree(view.state, view.state.selection.main.head);
  if (tree) setHeadingLevel(view, headingAt(view.state, tree) === level ? 0 : level);
};

/**
 * Insert plain text AT the current caret and place the caret right after
 * the inserted text. Use this from slash commands where the line is empty
 * (the `/<name>` was just stripped by the apply handler) and the caret
 * must end up *past* the new content — CM's default cursor mapping leaves
 * the caret BEFORE an at-cursor insertion.
 */
export const insertAtCursor = (view: EditorView, text: string): void => {
  const { from } = view.state.selection.main;
  view.dispatch({
    changes: { from, insert: text },
    selection: { anchor: from + text.length },
  });
  view.focus();
};

// ==========================
// Block insertion
// ==========================

/**
 * Insert a fenced code block at the current line and place the cursor on
 * the empty line between the fences, ready for typing.
 */
export const insertCodeBlock = (
  view: EditorView,
  options?: {
    /** Language tag appended to the opening fence (e.g. `javascript`,
     *  `python`, `mermaid`, `math`). Omit for an untagged fence. */
    language?: string;
    /** Pre-filled body content. If provided, the cursor lands at
     *  the END of the body (so the user can extend it). If absent,
     *  the body is empty and the cursor lands on the empty line
     *  between the fences. */
    body?: string;
  },
): void => {
  const language = options?.language ?? "";
  const body = options?.body ?? "";
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const separator = line.text.trim() ? "\n\n" : "";
  const opening = `\`\`\`${language}\n`;
  const closing = "\n```";
  // Body sits between opening and closing fence. When body is
  // non-empty we add it verbatim; when empty we leave a single
  // empty line for the user to fill in.
  const insert = `${separator}${opening}${body}${closing}\n`;
  // Caret position: end of body when body is pre-filled (so the
  // user can keep typing the snippet); otherwise the empty line
  // between the fences (the "blank canvas" UX).
  const caretOffset = separator.length + opening.length + body.length;
  view.dispatch({
    changes: { from: line.to, insert },
    selection: { anchor: line.to + caretOffset },
  });
  view.focus();
};

/**
 * Insert a `:::<type>` callout / info block and place the cursor on the
 * empty line between the markers.
 */
export const insertCallout = (view: EditorView, type: string): void => {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const separator = line.text.trim() ? "\n\n" : "";
  const opening = `:::${type}\n`;
  const closing = "\n:::";
  const insert = `${separator}${opening}${closing}\n`;
  view.dispatch({
    changes: { from: line.to, insert },
    selection: { anchor: line.to + separator.length + opening.length },
  });
  view.focus();
};

/**
 * Insert a referenceable data block. The `@ref` handle is selected
 * after insertion so the user can give it a descriptive name.
 */
export const insertDataBlock = (view: EditorView): void => {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const separator = line.text.trim() ? "\n\n" : "";
  const block = buildDataBlockTemplate();
  const insert = `${separator}${block}\n`;
  const insertStart = line.to;
  const blockStart = insertStart + separator.length;

  view.dispatch({
    changes: { from: insertStart, insert },
    selection: dataBlockRefSelection(blockStart),
  });
  view.focus();
};

// ==========================
// Tables
// ==========================

/** Build a markdown table skeleton with placeholder headers. */
const buildTable = (rows: number, cols: number, locale?: string): string => {
  const t = notebookWorkspaceMessages.resolve(locale ? [locale] : []).t;
  const header = `| ${Array.from({ length: cols }, (_, i) => t.tableHeader({ index: i + 1 })).join(" | ")} |`;
  const sep = `| ${Array.from({ length: cols }, () => "---").join(" | ")} |`;
  const body = Array.from({ length: rows }, () => `| ${Array.from({ length: cols }, () => "   ").join(" | ")} |`).join("\n");
  return `${header}\n${sep}\n${body}`;
};

/**
 * Insert a markdown table at the cursor.
 *
 * Two paths:
 *
 *   1. **Modal path** — `insertTable(view)` with no dimensions opens
 *      a prompt asking for rows/cols (default 3×3). Used by the
 *      `/table` slash command and the toolbar button.
 *
 *   2. **Direct path** — `insertTable(view, { rows, cols })` skips
 *      the prompt entirely. Used by the `/table<R>x<C>` power
 *      command so `/table2x4` inserts a 2×4 table immediately.
 *
 * After the table is in the document, the caret pre-selects the first
 * header cell's placeholder text (`Header 1`) so the user can start
 * typing immediately to replace it.
 */
export const insertTable = async (view: EditorView, dimensions?: { rows: number; cols: number }, locale?: string): Promise<void> => {
  const resolvedLocale = locale ?? (typeof document === "undefined" ? "en" : document.documentElement.lang);
  const t = notebookWorkspaceMessages.resolve([resolvedLocale]).t;
  let rows: number;
  let cols: number;
  if (dimensions) {
    // Clamp to the same ranges the modal accepts — defends against a
    // pathological `/table999x999` from someone testing edge cases.
    rows = Math.max(1, Math.min(50, Math.floor(dimensions.rows)));
    cols = Math.max(1, Math.min(20, Math.floor(dimensions.cols)));
  } else {
    const result = await prompts.form({
      title: t.insertTable,
      icon: "ti ti-table",
      fields: {
        rows: { type: "number", label: t.rows, default: 3, min: 1, max: 50, required: true },
        cols: { type: "number", label: t.columns, default: 3, min: 1, max: 20, required: true },
      },
    });
    if (!result) return;
    rows = result.rows;
    cols = result.cols;
  }

  const block = buildTable(rows, cols, resolvedLocale);
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const separator = line.text.trim() ? "\n\n" : "";
  const insert = `${separator}${block}\n`;
  const insertStart = line.to;
  const header1 = t.tableHeader({ index: 1 });
  const header1Offset = insert.indexOf(header1);

  view.dispatch({
    changes: { from: insertStart, insert },
    selection:
      header1Offset >= 0
        ? {
            anchor: insertStart + header1Offset,
            head: insertStart + header1Offset + header1.length,
          }
        : { anchor: insertStart + insert.length },
  });
  view.focus();
};

// ==========================
// Links
// ==========================

/**
 * Insert a `[Text](url)` template at the cursor (or wrap the current
 * selection as link text). Selects the URL placeholder so the user can type
 * over it directly.
 */
export const insertLink = (view: EditorView, locale?: string): void => {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  const resolvedLocale = locale ?? (typeof document === "undefined" ? "en" : document.documentElement.lang);
  const linkText = selected || notebookWorkspaceMessages.resolve([resolvedLocale]).t.linkText;
  const insert = `[${linkText}](url)`;
  view.dispatch({
    changes: { from, to, insert },
    selection: {
      anchor: from + linkText.length + 2,
      head: from + insert.length - 1,
    },
  });
  view.focus();
};

/**
 * Open the note picker and insert a markdown link to the chosen note.
 * Selected text becomes the link text; otherwise the picked note's title is
 * used.
 *
 * Yjs collab note: while the picker is open the editor is non-modal — a
 * concurrent edit by another peer could shift the captured selection by
 * the time we dispatch. Accepted tradeoff for KISS (user can ctrl+z).
 */
export const insertNoteLink = async (view: EditorView, notebookId: string, locale?: string): Promise<void> => {
  const sel = view.state.selection.main;
  const selectedText = view.state.sliceDoc(sel.from, sel.to);

  const picked = await openNoteLinkPrompt(notebookId, locale);
  if (!picked) return;

  const linkText = selectedText.length > 0 ? selectedText : picked.title;
  // `note://<shortId>` is our internal scheme — the read-mode HTML
  // renderer (`renderNotebookBook`) turns it into a navigable
  // `<a>`, and the page-handler resolves the short-id back to a UUID.
  // Carrying short-ids in markdown bodies (instead of full URLs)
  // means link references survive notebook renames / URL refactors
  // and stay short + portable across copy-paste between notebooks.
  const url = `note://${picked.id}`;
  const insert = `[${linkText}](${url})`;

  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: { anchor: sel.from + insert.length },
  });
  view.focus();
};
