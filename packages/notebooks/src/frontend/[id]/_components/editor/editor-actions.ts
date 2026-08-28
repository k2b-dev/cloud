import type { EditorView } from "@codemirror/view";
import { prompts } from "@k2b/ui";
import { buildDataBlockTemplate, dataBlockRefSelection } from "../../../lib/editor/data-block-template";
import { openNoteLinkPrompt } from "../search/openNoteSearchPrompt";
import { notebookWorkspaceMessages } from "../../messages";

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

/**
 * Toggle a markdown wrap mark (e.g. `**`, `_`, `~~`, `` ` ``) around the
 * current selection. Detects an already-wrapped selection (inside or outside
 * the marks) and unwraps in that case.
 */
export const wrapSelection = (view: EditorView, mark: string): void => {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  const markLen = mark.length;

  // Case 1: selected text itself starts and ends with the mark → unwrap inside
  if (selected.startsWith(mark) && selected.endsWith(mark) && selected.length >= markLen * 2) {
    view.dispatch({ changes: { from, to, insert: selected.slice(markLen, -markLen) } });
    view.focus();
    return;
  }

  // Case 2: marks exist around the selection in the document → unwrap outside
  const before = view.state.sliceDoc(Math.max(0, from - markLen), from);
  const after = view.state.sliceDoc(to, to + markLen);
  if (before === mark && after === mark) {
    view.dispatch({
      changes: { from: from - markLen, to: to + markLen, insert: selected },
      selection: { anchor: from - markLen, head: to - markLen },
    });
    view.focus();
    return;
  }

  // Default: wrap selection
  view.dispatch({
    changes: { from, to, insert: `${mark}${selected}${mark}` },
    selection: { anchor: from + markLen, head: to + markLen },
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

// ==========================
// Line prefixes (lists, quotes)
// ==========================

/**
 * Insert a per-line prefix (`- `, `1. `, `- [ ] `, `> `) at the current
 * line start. Existing line content is preserved; cursor stays where it was
 * (CodeMirror remaps it through the change).
 *
 * Toolbar-oriented: the user clicked while editing mid-line and wants the
 * caret to remain on the same word. For empty-line cases (slash commands)
 * use `insertAtCursor` instead, which explicitly advances the caret past
 * the inserted text.
 */
export const insertLinePrefix = (view: EditorView, prefix: string): void => {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  view.dispatch({ changes: { from: line.from, to: line.from, insert: prefix } });
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
    /** Language tag appended to the opening fence (e.g. `script`,
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
 * after insertion so users discover that scripts can read it via
 * `kit.data("ref")` while still being nudged to rename it.
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
  // renderer (`transformNoteLinks`) rewrites it into a navigable
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
