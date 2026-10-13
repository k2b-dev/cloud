import { isolateHistory } from "@codemirror/commands";
import { ensureSyntaxTree } from "@codemirror/language";
import { type ChangeSet, type ChangeSpec, EditorSelection, type EditorState, type SelectionRange } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { prompts } from "@k2b/ui";
import type { SyntaxNode } from "@lezer/common";
import { TAG_REGEX } from "../../../lib/editor/_lib/inline-syntax";
import { buildDataBlockTemplate, dataBlockRefSelection } from "../../../lib/editor/data-block-template";
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

export type InlineMark = "bold" | "italic" | "strikethrough" | "code";

const inlineMarks = {
  bold: { node: "StrongEmphasis", delimiter: "**" },
  italic: { node: "Emphasis", delimiter: "*" },
  strikethrough: { node: "Strikethrough", delimiter: "~~" },
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
 * Every inserted mark must parse as Markdown markup; otherwise nothing
 * changes. This covers code, link targets, ranges that cross blocks or other
 * spans, and runs that CommonMark cannot close. The command also does
 * nothing inside a `#tag` or before the syntax tree covers the range. Only
 * the marks change, in one transaction that is its own undo step, so a
 * peer's concurrent edit inside the text survives.
 */
export const toggleInlineMark = (view: EditorView, mark: InlineMark): void => {
  const { state } = view;
  const selection = state.selection.main;
  let { from, to } = selection;
  if (!selection.empty) {
    const selected = state.sliceDoc(from, to);
    const trimmed = selected.trim();
    if (!trimmed) return;
    from += selected.length - selected.trimStart().length;
    to = from + trimmed.length;
  }
  const tree = parsedTree(state, to);
  if (!tree) return;

  const { node: nodeType, delimiter } = inlineMarks[mark];
  // Spans that overlap or touch the range, with their opening and closing marks; visited outside in.
  const spans = (from: number, to: number) => {
    const found: { from: number; to: number; opening: SyntaxNode; closing: SyntaxNode }[] = [];
    tree.iterate({
      from,
      to,
      enter: ({ name, node }) => {
        if (name === nodeType && node.firstChild && node.lastChild)
          found.push({ from: node.from, to: node.to, opening: node.firstChild, closing: node.lastChild });
      },
    });
    return found;
  };
  const edits: ChangeSpec[] = [];
  const inserts: { at: number; text: string }[] = [];
  const removeMarks = ({ opening, closing }: { opening: SyntaxNode; closing: SyntaxNode }) => {
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
        const span = nodes.some(
          (node) => a <= node.from && node.to <= b && node.from <= a + delimiter.length && node.to >= b - delimiter.length,
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
  const containing = spans(from, to).findLast((node) => node.from <= from && node.to >= to);
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

const HEADING_PREFIX_REGEX = /^(#{1,6})\s/;

/**
 * Cycle the current line's heading level (no heading → H1 → H2 → H3 → H4 →
 * no heading). Used by the toolbar's heading button.
 */
export const cycleHeading = (view: EditorView): void => {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const match = line.text.match(/^(#{1,4})\s/);

  if (match) {
    const level = match[1]!.length;
    const replacement = level < 4 ? "#".repeat(level + 1) + " " : "";
    view.dispatch({ changes: { from: line.from, to: line.from + level + 1, insert: replacement } });
  } else {
    view.dispatch({ changes: { from: line.from, to: line.from, insert: "# " } });
  }
  view.focus();
};

/**
 * Set the current line's heading to a specific level (1–6). Replaces any
 * existing heading prefix; inserts at line start otherwise. Used by slash
 * commands where the user picked a specific level (`/h1`, `/h2`, …).
 */
export const setHeading = (view: EditorView, level: number): void => {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const prefix = `${"#".repeat(level)} `;
  const match = line.text.match(HEADING_PREFIX_REGEX);
  const replaceTo = match ? line.from + match[0].length : line.from;

  view.dispatch({
    changes: { from: line.from, to: replaceTo, insert: prefix },
    selection: { anchor: line.from + prefix.length },
  });
  view.focus();
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
