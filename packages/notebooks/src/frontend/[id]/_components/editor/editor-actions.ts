import { syntaxTree } from "@codemirror/language";
import type { ChangeSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { prompts } from "@k2b/ui";
import type { SyntaxNode } from "@lezer/common";
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

/**
 * Toggle an inline Markdown mark on the selection, or on the word at the
 * caret. Whitespace at the selection edges stays outside the mark. Inside a
 * span of the same kind (also `_x_` or `__x__`), the span's marks are removed.
 * Otherwise the mark wraps the range and absorbs same-kind spans it overlaps,
 * so the result stays valid Markdown. Only the marks change, in one
 * transaction, so a peer's concurrent edit inside the text survives.
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

  const { node: nodeType, delimiter } = inlineMarks[mark];
  const spans = (from: number, to: number) => {
    const nodes: SyntaxNode[] = [];
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name === nodeType) nodes.push(node.node);
      },
    });
    return nodes;
  };
  const edits: ChangeSpec[] = [];
  const removeMarks = (node: SyntaxNode) => {
    const opening = node.firstChild;
    const closing = node.lastChild;
    if (opening && closing) edits.push({ from: opening.from, to: opening.to }, { from: closing.from, to: closing.to });
  };

  // Spans are visited outside in, so the last containing one is the innermost.
  const containing = spans(from, to).findLast((node) => node.from <= from && node.to >= to);
  if (containing) {
    removeMarks(containing);
    const changes = state.changes(edits);
    view.dispatch({
      changes,
      selection: { anchor: changes.mapPos(selection.anchor, 1), head: changes.mapPos(selection.head, 1) },
    });
    view.focus();
    return;
  }

  if (selection.empty) {
    const word = state.wordAt(selection.head);
    if (!word) return;
    ({ from, to } = word);
  }
  // Same-kind spans nest but never cross, so the spans overlapping the range are all there is to absorb.
  for (const node of spans(from, to).filter((node) => node.from < to && node.to > from)) {
    removeMarks(node);
    from = Math.min(from, node.from);
    to = Math.max(to, node.to);
  }
  const changes = state.changes([...edits, { from, insert: delimiter }, { from: to, insert: delimiter }]);
  const start = changes.mapPos(from, -1) + delimiter.length;
  const end = changes.mapPos(to, 1) - delimiter.length;
  const caret = Math.max(start, Math.min(end, changes.mapPos(selection.head, 1)));
  view.dispatch({
    changes,
    selection: selection.empty
      ? { anchor: caret }
      : selection.anchor <= selection.head
        ? { anchor: start, head: end }
        : { anchor: end, head: start },
  });
  view.focus();
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
