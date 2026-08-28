import { startCompletion } from "@codemirror/autocomplete";
import { crypto as stdCrypto } from "@k2b/stdlib";
import { navigateToNotebookNote } from "../../../../lib/soft-navigation";
import { buildNoteUrl } from "../../../../params";
import { openNoteSwitchPrompt } from "../../search/openNoteSearchPrompt";
import { openAttachmentPicker } from "../AttachmentPicker";
import { insertAtCursor, insertCallout, insertCodeBlock, insertDataBlock, insertLink, insertTable, setHeading } from "../editor-actions";
import type { SlashCommand } from "./types";

// =============================================================================
// Lorem-ipsum paragraphs — used by /lorem<N>
// =============================================================================

/**
 * Hand-picked variety of latin-style filler paragraphs. We cycle
 * through them when the user requests N paragraphs so the output
 * has natural variation instead of N copies of the same string.
 *
 * Each paragraph is one line — markdown renders successive
 * paragraphs as separate blocks when separated by a blank line,
 * which is what the /lorem<N> emitter outputs.
 */
const LOREM_PARAGRAPHS: string[] = [
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.",
  "Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.",
  "Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.",
  "Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.",
  "Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam.",
  "Eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo.",
  "Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores.",
  "Neque porro quisquam est, qui dolorem ipsum quia dolor sit amet, consectetur, adipisci velit, sed quia non numquam.",
];

/** Build a lorem block. N paragraphs, joined by blank lines so
 *  markdown renders them as separate `<p>` elements. Cycles through
 *  the registry so 12 paragraphs reuse the same 8 with a wrap. */
const buildLorem = (n: number): string => {
  const clamped = Math.max(1, Math.min(20, Math.floor(n)));
  return Array.from({ length: clamped }, (_, i) => LOREM_PARAGRAPHS[i % LOREM_PARAGRAPHS.length]).join("\n\n");
};

// =============================================================================
// Date / time formatters — used by /now, /date, /time, /tomorrow, /yesterday
// =============================================================================

/** Two-digit pad. */
const pad = (n: number): string => n.toString().padStart(2, "0");

/** `YYYY-MM-DD` in the user's local timezone — same format as the
 *  rest of the app's plain-text date displays, ISO-friendly. */
const formatDate = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** `HH:MM` in the user's local timezone — 24-hour. */
const formatTime = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Combined: `YYYY-MM-DD HH:MM`. */
const formatDateTime = (d: Date): string => `${formatDate(d)} ${formatTime(d)}`;

/**
 * Slash-command registry. Order in this array = display order in the
 * autocomplete popup (commands are filtered + grouped by `section`, but
 * within a section the array order is preserved).
 *
 * Adding a new command:
 *   1. Drop a `SlashCommand` object into the right section below.
 *   2. Pick a `name` that is unique and short — that's what the user types.
 *   3. Implement `run(view, ctx)` using helpers from `editor-actions.ts`
 *      where possible so the toolbar and slash command stay in lockstep.
 */
export const slashCommands: SlashCommand[] = [
  // ── Formatting ───────────────────────────────────────────
  //
  // Headings 1-6. Each entry is registered separately so all six
  // show up in the autocomplete popup with their own icon. We
  // ALSO set `params: /^[1-6]$/` on each so typos like `/h7` are
  // rejected (matchCommand falls back to the prefix path; with
  // `/h7` typed against name "h1" + params /^[1-6]$/, the suffix
  // "7" doesn't match the regex, and "h1" isn't a substring of
  // "h7" either — `/h7` correctly yields no match).
  {
    name: "h1",
    label: "Heading 1",
    icon: "ti-h-1",
    section: "Formatting",
    aliases: ["heading1", "title"],
    run: (view) => setHeading(view, 1),
  },
  {
    name: "h2",
    label: "Heading 2",
    icon: "ti-h-2",
    section: "Formatting",
    aliases: ["heading2", "subtitle"],
    run: (view) => setHeading(view, 2),
  },
  {
    name: "h3",
    label: "Heading 3",
    icon: "ti-h-3",
    section: "Formatting",
    aliases: ["heading3"],
    run: (view) => setHeading(view, 3),
  },
  {
    name: "h4",
    label: "Heading 4",
    icon: "ti-h-4",
    section: "Formatting",
    aliases: ["heading4"],
    run: (view) => setHeading(view, 4),
  },
  {
    name: "h5",
    label: "Heading 5",
    icon: "ti-h-5",
    section: "Formatting",
    aliases: ["heading5"],
    run: (view) => setHeading(view, 5),
  },
  {
    name: "h6",
    label: "Heading 6",
    icon: "ti-h-6",
    section: "Formatting",
    aliases: ["heading6"],
    run: (view) => setHeading(view, 6),
  },
  {
    name: "quote",
    label: "Quote",
    icon: "ti-quote",
    section: "Formatting",
    aliases: ["blockquote", "citation"],
    run: (view) => insertAtCursor(view, "> "),
  },
  {
    name: "divider",
    label: "Divider",
    icon: "ti-minus",
    section: "Formatting",
    description: "Horizontal rule",
    aliases: ["hr", "separator", "rule"],
    run: (view) => insertAtCursor(view, "---\n"),
  },

  // ── Lists ────────────────────────────────────────────────
  //
  // All three list commands support a count suffix — `/list5` spawns
  // five empty bullets, `/todo3` three checkboxes, `/numbered7` a
  // 1.-through-7. ordered list. Without the suffix they behave like
  // before: insert a single prefix at the cursor.
  //
  // We clamp the count to a sensible upper bound (50) to defend
  // against `/list9999` slowing the editor down. Lists of more than
  // ~20 items via a slash command are rare in practice anyway.
  {
    name: "list",
    label: "Bullet list",
    icon: "ti-list",
    section: "Lists",
    description: "Bullet list — /listN for N empty items",
    aliases: ["bullet", "ul", "unordered"],
    params: /^(\d+)$/,
    run: (view, ctx, params) => {
      if (params) {
        const n = Math.max(1, Math.min(50, Number.parseInt(params[1]!, 10)));
        insertAtCursor(view, Array.from({ length: n }, () => "- ").join("\n"));
      } else {
        insertAtCursor(view, "- ");
      }
    },
  },
  {
    name: "numbered",
    label: "Numbered list",
    icon: "ti-list-numbers",
    section: "Lists",
    description: "Numbered list — /numberedN for 1.-N. items",
    aliases: ["ol", "ordered", "enumerate"],
    params: /^(\d+)$/,
    run: (view, _ctx, params) => {
      if (params) {
        const n = Math.max(1, Math.min(50, Number.parseInt(params[1]!, 10)));
        insertAtCursor(view, Array.from({ length: n }, (_, i) => `${i + 1}. `).join("\n"));
      } else {
        insertAtCursor(view, "1. ");
      }
    },
  },
  {
    name: "todo",
    label: "Checklist",
    icon: "ti-checkbox",
    section: "Lists",
    description: "Checklist — /todoN for N empty checkboxes",
    aliases: ["checkbox", "task", "tasks"],
    params: /^(\d+)$/,
    run: (view, _ctx, params) => {
      if (params) {
        const n = Math.max(1, Math.min(50, Number.parseInt(params[1]!, 10)));
        insertAtCursor(view, Array.from({ length: n }, () => "- [ ] ").join("\n"));
      } else {
        insertAtCursor(view, "- [ ] ");
      }
    },
  },

  // ── Insert ───────────────────────────────────────────────
  {
    name: "code",
    label: "Code block",
    icon: "ti-code",
    section: "Insert",
    aliases: ["codeblock", "pre", "snippet"],
    run: (view) => insertCodeBlock(view),
  },
  // Notebook-special fence shortcuts. Each inserts a fully-tagged
  // block directly without going through the ``` language picker
  // — power users typing `/script` skip an extra step. The mermaid
  // and math variants include a starter template so the rendered
  // widget shows something useful immediately (an empty mermaid
  // block renders as a parse error chip).
  {
    name: "script",
    label: "Script block",
    icon: "ti-bolt",
    section: "Insert",
    description: "Live kit script (\\`\\`\\`script)",
    aliases: ["kit"],
    run: (view) => insertCodeBlock(view, { language: "script" }),
  },
  {
    name: "mermaid",
    label: "Mermaid diagram",
    icon: "ti-binary-tree",
    section: "Insert",
    description: "Diagram block (\\`\\`\\`mermaid)",
    aliases: ["diagram", "graph", "flowchart"],
    run: (view) =>
      insertCodeBlock(view, {
        language: "mermaid",
        body: "graph TD\n  A[Start] --> B[End]",
      }),
  },
  {
    name: "math",
    label: "Math block",
    icon: "ti-math-integral",
    section: "Insert",
    description: "Block KaTeX (\\`\\`\\`math)",
    aliases: ["katex", "tex", "latex", "formula", "equation"],
    run: (view) => insertCodeBlock(view, { language: "math", body: "E = mc^2" }),
  },
  // Quick language shortcuts — covers the languages that come up
  // most often in technical notes. The ``` picker covers the rest
  // (yaml, html, css, go, rust, etc.); these five are here purely
  // because they're fast-typed enough to be worth a dedicated
  // entry. Each is a block command (auto-newline mid-line).
  {
    name: "js",
    label: "JavaScript block",
    icon: "ti-brand-javascript",
    section: "Insert",
    description: "\\`\\`\\`javascript",
    aliases: ["javascript", "node"],
    run: (view) => insertCodeBlock(view, { language: "javascript" }),
  },
  {
    name: "py",
    label: "Python block",
    icon: "ti-brand-python",
    section: "Insert",
    description: "\\`\\`\\`python",
    aliases: ["python"],
    run: (view) => insertCodeBlock(view, { language: "python" }),
  },
  {
    name: "sql",
    label: "SQL block",
    icon: "ti-database",
    section: "Insert",
    description: "\\`\\`\\`sql",
    aliases: ["query"],
    run: (view) => insertCodeBlock(view, { language: "sql" }),
  },
  {
    name: "json",
    label: "JSON block",
    icon: "ti-braces",
    section: "Insert",
    description: "\\`\\`\\`json",
    run: (view) => insertCodeBlock(view, { language: "json" }),
  },
  {
    name: "bash",
    label: "Shell block",
    icon: "ti-terminal",
    section: "Insert",
    description: "\\`\\`\\`bash",
    aliases: ["sh", "shell"],
    run: (view) => insertCodeBlock(view, { language: "bash" }),
  },
  {
    name: "table",
    label: "Table",
    icon: "ti-table",
    section: "Insert",
    description: "Insert a markdown table — try /table2x4 for direct sizing",
    // Power-cmd: `/table<R>x<C>` inserts an R×C table immediately,
    // bypassing the modal. Bare `/table` keeps the modal flow.
    params: /^(\d+)x(\d+)$/,
    run: (view, ctx, params) => {
      if (params) {
        const rows = Number.parseInt(params[1]!, 10);
        const cols = Number.parseInt(params[2]!, 10);
        return insertTable(view, { rows, cols }, ctx.locale);
      }
      return insertTable(view, undefined, ctx.locale);
    },
  },
  {
    name: "data",
    label: "Data block",
    icon: "ti-database",
    section: "Insert",
    description: '@ref + :::data block for kit.data("ref")',
    aliases: ["dataset", "properties", "kv", "attrs"],
    run: (view) => insertDataBlock(view),
  },
  {
    name: "link",
    label: "Link",
    icon: "ti-link",
    section: "Insert",
    description: "Insert a `[text](url)` template",
    aliases: ["url", "href", "hyperlink"],
    run: (view) => insertLink(view),
  },
  {
    name: "note",
    label: "Link to note",
    icon: "ti-connection",
    section: "Insert",
    description: "Pick a note inline — type to filter, Enter to insert",
    aliases: ["wikilink", "crosslink", "wiki", "ref", "link2note"],
    // INLINE — note refs are inline citations, no new line needed.
    inline: true,
    // Insert `[[` at the cursor and programmatically open the
    // completion popup. The note-link-autocomplete source fires on
    // the `[[` trigger and surfaces the notebook's notes. Picking a
    // note rewrites the `[[…]]` (or `[[…`) range with a standard
    // markdown `[Title](note-url)` link.
    run: (view) => {
      insertAtCursor(view, "[[");
      // Defer to next microtask so the `[[` dispatch settles before
      // we kick off startCompletion — otherwise the source's
      // matchBefore wouldn't see the brackets yet.
      queueMicrotask(() => startCompletion(view));
    },
  },
  {
    name: "file",
    label: "Reference file",
    icon: "ti-paperclip",
    section: "Insert",
    description: "Reference an existing attachment inline — type to filter",
    aliases: ["image", "photo", "picture", "img", "pic", "attach", "attachment", "media", "ref-file"],
    // INLINE — attachment refs are inline citations (image embed or
    // markdown link), no new line needed.
    inline: true,
    // Insert `![[` and trigger the attachment-autocomplete source.
    // The source filters EXISTING attachments by typed prefix and
    // picks resolve to ![filename](attach://id) for images or
    // [filename](attach://id) for non-images. For UPLOADING new
    // files, the user types /upload instead (see below).
    run: (view) => {
      insertAtCursor(view, "![[");
      queueMicrotask(() => startCompletion(view));
    },
  },
  {
    name: "upload",
    label: "Upload file",
    icon: "ti-upload",
    section: "Insert",
    description: "Open the file picker to upload a new attachment",
    aliases: ["new-file", "new-attachment"],
    // The upload flow stays modal — file picking is a native browser
    // dialog that can't be turned into an inline autocomplete. Keep
    // the existing AttachmentPicker behavior here for users who
    // need to add NEW files. `/file` covers referencing EXISTING ones.
    run: (_view, ctx) => openAttachmentPicker(ctx.notebookId),
  },
  {
    name: "tag",
    label: "Tag",
    icon: "ti-hash",
    section: "Insert",
    description: "Insert a #tag — picker opens inline",
    aliases: ["tags", "label", "category", "hashtag"],
    // INLINE — no auto-newline mid-line. /tag is for inserting a
    // tag reference at the caret, not for starting a new block.
    inline: true,
    // No modal — we insert `#` at the cursor and programmatically
    // open the autocomplete popup. The tag-autocomplete source's
    // explicit-mode branch (matchBefore `#\w*`) surfaces the full
    // tag list immediately; the user types to narrow.
    run: (view) => {
      insertAtCursor(view, "#");
      // Defer to next microtask so the dispatch from `insertAtCursor`
      // settles before we kick off the completion query — otherwise
      // `startCompletion` runs against the pre-insert state and the
      // source's matchBefore doesn't see the `#` yet.
      queueMicrotask(() => startCompletion(view));
    },
  },

  // ── Callouts (info blocks) ───────────────────────────────
  {
    name: "callout",
    label: "Callout",
    icon: "ti-chevron-right",
    section: "Callouts",
    description: ":::note",
    aliases: ["notice", "box"],
    run: (view) => insertCallout(view, "note"),
  },
  {
    name: "info",
    label: "Info",
    icon: "ti-info-circle",
    section: "Callouts",
    description: ":::info",
    aliases: ["tip", "hint"],
    run: (view) => insertCallout(view, "info"),
  },
  {
    name: "success",
    label: "Success",
    icon: "ti-check",
    section: "Callouts",
    description: ":::success",
    aliases: ["ok", "done"],
    run: (view) => insertCallout(view, "success"),
  },
  {
    name: "warning",
    label: "Warning",
    icon: "ti-alert-circle",
    section: "Callouts",
    description: ":::warning",
    aliases: ["warn", "caution", "alert"],
    run: (view) => insertCallout(view, "warning"),
  },
  {
    name: "danger",
    label: "Danger",
    icon: "ti-alert-hexagon",
    section: "Callouts",
    description: ":::danger",
    aliases: ["error", "critical", "fail"],
    run: (view) => insertCallout(view, "danger"),
  },

  // ── Insert: date / time inserters ────────────────────────
  //
  // All five are INLINE commands — they insert a string at the
  // cursor without forcing a fresh line. Same section as the other
  // inserters (link / note / file / tag) so they group naturally
  // in the popup.
  //
  // Formatting is intentionally plain ISO-ish (`YYYY-MM-DD`,
  // `HH:MM`) so the inserted text reads identically in any
  // viewer / search index / export — no locale-dependent surprises.
  // Local timezone is used (not UTC) so "today" matches what the
  // user's wall clock says.
  {
    name: "now",
    label: "Date + time",
    icon: "ti-clock",
    section: "Insert",
    description: "Insert YYYY-MM-DD HH:MM",
    aliases: ["timestamp", "datetime"],
    inline: true,
    run: (view) => insertAtCursor(view, formatDateTime(new Date())),
  },
  {
    name: "date",
    label: "Today's date",
    icon: "ti-calendar",
    section: "Insert",
    description: "Insert YYYY-MM-DD",
    aliases: ["today"],
    inline: true,
    run: (view) => insertAtCursor(view, formatDate(new Date())),
  },
  {
    name: "time",
    label: "Current time",
    icon: "ti-clock-hour-4",
    section: "Insert",
    description: "Insert HH:MM",
    inline: true,
    run: (view) => insertAtCursor(view, formatTime(new Date())),
  },
  {
    name: "tomorrow",
    label: "Tomorrow's date",
    icon: "ti-calendar-plus",
    section: "Insert",
    description: "Insert YYYY-MM-DD (today + 1 day)",
    aliases: ["nextday"],
    inline: true,
    run: (view) => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      insertAtCursor(view, formatDate(d));
    },
  },
  {
    name: "yesterday",
    label: "Yesterday's date",
    icon: "ti-calendar-minus",
    section: "Insert",
    description: "Insert YYYY-MM-DD (today − 1 day)",
    aliases: ["prevday"],
    inline: true,
    run: (view) => {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      insertAtCursor(view, formatDate(d));
    },
  },

  // ── Insert: ID generators ────────────────────────────────
  //
  // Both inline — drop an identifier wherever the caret happens to
  // be. UUID is the standard 36-char hex/dashes; readable-id is the
  // stdlib's human-friendly variant (e.g. `a3X-B7nm-4Kp-qR9v`) that
  // sits between "memorable" and "unique" — great for ad-hoc note
  // anchors or quick references.
  {
    name: "uuid",
    label: "UUID",
    icon: "ti-fingerprint",
    section: "Insert",
    description: "Insert a v4 UUID",
    aliases: ["guid"],
    inline: true,
    run: (view) => insertAtCursor(view, crypto.randomUUID()),
  },
  {
    name: "id",
    label: "Readable ID",
    icon: "ti-id-badge-2",
    section: "Insert",
    description: "Insert a short human-friendly ID",
    aliases: ["shortid", "readableid"],
    inline: true,
    run: (view) => insertAtCursor(view, stdCrypto.common.readableId()),
  },
  {
    name: "lorem",
    label: "Lorem ipsum",
    icon: "ti-blockquote",
    section: "Insert",
    description: "Placeholder text — try /lorem3 for 3 paragraphs",
    aliases: ["placeholder", "ipsum", "filler"],
    // Block command — paragraphs need their own line context to
    // render as separate blocks in markdown.
    params: /^(\d+)$/,
    run: (view, _ctx, params) => {
      const n = params ? Number.parseInt(params[1]!, 10) : 1;
      insertAtCursor(view, buildLorem(n));
    },
  },

  // ── Navigation ───────────────────────────────────────────
  {
    name: "switch",
    label: "Switch to note",
    icon: "ti-arrows-right-left",
    section: "Navigation",
    description: "Open a different note in this notebook",
    aliases: ["goto", "jump", "open", "nav"],
    run: async (_view, ctx) => {
      const picked = await openNoteSwitchPrompt(ctx.notebookId);
      if (!picked) return;
      await navigateToNotebookNote(buildNoteUrl(ctx.notebookId, picked.id));
    },
  },
];
