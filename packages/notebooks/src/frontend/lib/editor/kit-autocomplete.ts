/**
 * CodeMirror autocompletion for notebook script globals inside
 * ` ```script ` fenced code blocks.
 *
 * The runtime intentionally exposes only four top-level namespaces:
 * `current`, `nb`, `ui`, and `std`. Completion is scoped to script
 * fences so normal JS/TS code blocks do not receive notebook-only
 * globals.
 *
 * Registry: a top-level list of namespaces + one list of methods
 * per namespace, plus nested lists for paths like `ui.prompt` and
 * `nb.attachments`. Each
 * Completion carries:
 *  - `label` — the identifier
 *  - `type` — `namespace` / `method` / `property` (drives CM's icon)
 *  - `detail` — condensed signature
 *  - `info` — longer description shown in the side panel
 *
 * Methods that take arguments use `snippetCompletion(template, …)`
 * so accepting the completion inserts a parameter scaffold the user
 * can tab through.
 */
import { type Completion, type CompletionContext, type CompletionResult, snippetCompletion } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { GERMAN_COMPLETION_HELP } from "./kit-autocomplete.de";

/**
 * Custom field we attach to each script API `Completion` so the shared
 * option-renderer in `slash-commands/index.ts` can pick the right
 * Tabler icon. CM doesn't have a built-in `icon` field; we tag our
 * own and the renderer reads it via the `KitCompletion` cast.
 *
 * Only top-level namespace entries set `kitIcon` explicitly. For
 * everything else (methods, properties, sub-namespaces) the renderer
 * falls back to type-derived icons:
 *  - `method`    → `ti-bracket-x`  ("call this")
 *  - `property`  → `ti-circle-dot` ("read this")
 *  - `namespace` → `ti-folder`     (sub-namespace like `std.crypto.common`)
 */
export type KitCompletion = Completion & { kitIcon?: string };

/**
 * Tag a CM `Completion` with a Tabler icon class. The structural-cast
 * dance is here because CM's `Completion` interface has no built-in
 * icon field; we extend it via the `KitCompletion` shape and the
 * renderer in `slash-commands/index.ts` reads the same field with a
 * symmetric cast.
 *
 * Returns the original object (mutated in place) so callers can
 * write `withIcon(snippetCompletion(...), "ti-foo")` inline.
 */
export const withIcon = <C extends Completion>(c: C, icon: string): C => {
  (c as KitCompletion).kitIcon = icon;
  return c;
};

const localizeOptions = (options: readonly Completion[], namespace: string, locale?: string): Completion[] => {
  if (!/^de(?:-|$)/i.test(locale ?? "")) return [...options];
  return options.map((completion) => {
    const path = namespace ? `${namespace}.${completion.label}` : completion.label;
    const help = GERMAN_COMPLETION_HELP[path];
    if (!help) throw new Error(`Missing German completion help for ${path}`);
    return { ...completion, ...help };
  });
};

// =============================================================================
// Top-level namespaces
// =============================================================================

/** Top-level namespace entry shortcut — assigns a Tabler icon
 *  per namespace so the option-list reads like a sidebar nav. */
const ns = (label: string, kitIcon: string, detail: string, info: string): KitCompletion => ({
  label,
  type: "namespace",
  detail,
  info,
  kitIcon,
});

const topLevelCompletions: KitCompletion[] = [
  ns(
    "current",
    "ti-note",
    "Current note",
    "Read/write access to the note this script lives in. Includes named-block helpers like `current.table('ideas')`.",
  ),
  ns("nb", "ti-notebook", "Notebook API", "List, search, fetch, create, update, and delete notes in the current notebook."),
  ns("ui", "ti-layout-grid", "UI builders", "Build script output: tables, charts, buttons, prompts, markdown, links, cards."),
  ns("std", "ti-tool", "Stdlib helpers", "Curated @k2b/stdlib namespaces: dates, text, fuzzy, charts, files, images, timing, ..."),
];

// =============================================================================
// Per-namespace completions
// =============================================================================

// ── current ──────────────────────────────────────────────────────
const noteCompletions: Completion[] = [
  // Read getters
  { label: "id", type: "property", detail: "string", info: "6-char short-id of this note." },
  { label: "title", type: "property", detail: "string", info: "Current title (snapshot at script-run time)." },
  { label: "content", type: "property", detail: "string", info: "Live note body (reads Y.Text in edit-mode)." },
  { label: "tags", type: "property", detail: "string[]", info: "Extracted `#tags` from the current content." },
  { label: "notebook", type: "property", detail: "{ id, name }", info: "Owning notebook reference." },
  { label: "createdAt", type: "property", detail: "ISO string", info: "Creation timestamp." },
  { label: "updatedAt", type: "property", detail: "ISO string", info: "Last update timestamp." },
  { label: "lockedAt", type: "property", detail: "ISO string | null", info: "Non-null when the note is locked (read-only)." },
  ns(
    "kv",
    "ti-users-group",
    "Current note KV",
    "Collaborative per-current-note key-value store. Use `current.kv.observe(...)` for live updates.",
  ),
  snippetCompletion("table(${1:'ideas'})", {
    label: "table",
    type: "method",
    detail: "(name) → table view | undefined",
    info: "Read a named `@name` markdown table. On `current`, the returned table also has `.add(...)`.",
  }),
  snippetCompletion("tables(${1:'ideas'})", {
    label: "tables",
    type: "method",
    detail: "(name?) → table views",
    info: "Read all matching named tables. Omit the name to read every named table in this note.",
  }),
  snippetCompletion("list(${1:'shopping'})", {
    label: "list",
    type: "method",
    detail: "(name) → list view | undefined",
    info: "Read a named `@name` list. On `current`, the returned list also has `.add(...)`.",
  }),
  snippetCompletion("lists(${1:'shopping'})", {
    label: "lists",
    type: "method",
    detail: "(name?) → list views",
    info: "Read all matching named bullet lists. Omit the name to read every named list.",
  }),
  snippetCompletion("todo(${1:'shopping'})", {
    label: "todo",
    type: "method",
    detail: "(name) → todo view | undefined",
    info: "Read a named checkbox list like `@shopping` followed by `- [ ] milk`.",
  }),
  snippetCompletion("todos(${1:'shopping'})", {
    label: "todos",
    type: "method",
    detail: "(name?) → todo views",
    info: "Read all matching named checkbox lists. Omit the name to read every named todo list.",
  }),
  snippetCompletion("data(${1:'recipe'})", {
    label: "data",
    type: "method",
    detail: "(name) → data view | undefined",
    info: "Read a named `@name` / `:::data` block. On `current`, the returned data view also has `.set(...)`.",
  }),
  snippetCompletion("dataBlocks(${1:'recipe'})", {
    label: "dataBlocks",
    type: "method",
    detail: "(name?) → data views",
    info: "Read all matching named `:::data` blocks. Omit the name to read every named data block.",
  }),
  snippetCompletion("section(${1:'log'})", {
    label: "section",
    type: "method",
    detail: "(name) → section view | undefined",
    info: "Read a named heading section. On `current`, the returned section also has `.append(...)`.",
  }),
  snippetCompletion("sections(${1:'log'})", {
    label: "sections",
    type: "method",
    detail: "(name?) → section views",
    info: "Read all matching named heading sections. Omit the name to read every named section.",
  }),
  // Writes
  snippetCompletion("setContent(${1:'markdown'})", {
    label: "setContent",
    type: "method",
    detail: "(content) → Promise<void>",
    info: "Replace the entire body in one Y.Text transaction.",
  }),
  snippetCompletion("appendContent(${1:'markdown'})", {
    label: "appendContent",
    type: "method",
    detail: "(markdown) → Promise<void>",
    info: "Append markdown to the end. Auto-inserts `\\n\\n` separator if needed.",
  }),
  snippetCompletion("prependContent(${1:'markdown'})", {
    label: "prependContent",
    type: "method",
    detail: "(markdown) → Promise<void>",
    info: "Prepend markdown to the start. Auto-inserts trailing `\\n\\n`.",
  }),
  snippetCompletion("insertContentAt({ line: ${1:0}, col: ${2:0} }, ${3:'markdown'})", {
    label: "insertContentAt",
    type: "method",
    detail: "({line, col?}, markdown) → Promise<void>",
    info: "Insert at a specific (line, col). Clamps gracefully when out-of-range.",
  }),
  snippetCompletion("replaceLine(${1:0}, ${2:'new line text'})", {
    label: "replaceLine",
    type: "method",
    detail: "(line, text) → Promise<void>",
    info: "Replace the entire line at the given 0-indexed line number.",
  }),
];

// ── nb ────────────────────────────────────────────────────
const notesCompletions: Completion[] = [
  ns("attachments", "ti-paperclip", "Notebook attachments", "Upload, list, fetch, insert, and remove attachments in the current notebook."),
  ns("tags", "ti-tag", "Tag index", "List all `#tags` in the notebook and find notes for a tag."),
  ns("localKV", "ti-device-floppy", "Personal notebook KV", "Private per-user, per-notebook persistent key-value store."),
  {
    label: "list",
    type: "method",
    detail: "() → Promise<KitNote[]>",
    info: "All notes in the current notebook (paginated under the hood, capped at 1000).",
  },
  snippetCompletion("get(${1:'shortId'})", {
    label: "get",
    type: "method",
    detail: "(shortId) → Promise<KitNote | null>",
    info: "Fetch a single note by short-id. Returns null if not found or cross-notebook.",
  }),
  snippetCompletion("search(${1:'query'})", {
    label: "search",
    type: "method",
    detail: "(query | KitQuery) → Promise<KitNote[]>",
    info: "Search by string (title + content) or structured query with tags / date ranges / limit / offset.",
  }),
  snippetCompletion("searchTags(${1:'tag'})", {
    label: "searchTags",
    type: "method",
    detail: "(tag | tags, options?) → Promise<KitNote[]>",
    info: "Find notes that contain all given tags. `search('#garden')` also takes this path.",
  }),
  snippetCompletion("create({ content: ${1:'# New note'} })", {
    label: "create",
    type: "method",
    detail: "({ parentId?, content? }?) → Promise<KitNote>",
    info: "Create a note. Its title comes from content; without content the notebook default title template is used.",
  }),
  snippetCompletion("update(${1:'shortId'}, { parentId: ${2:null} })", {
    label: "update",
    type: "method",
    detail: "(shortId, { parentId }) → Promise<KitNote>",
    info: "Move an existing note below another note or to the notebook root.",
  }),
  snippetCompletion("remove(${1:'shortId'})", {
    label: "remove",
    type: "method",
    detail: "(shortId) → Promise<void>",
    info: "Delete a note. Permanent.",
  }),
];

// ── nb.attachments ──────────────────────────────────────────────
const attachmentsCompletions: Completion[] = [
  { label: "list", type: "method", detail: "() → Promise<KitAttachment[]>", info: "All attachments in this notebook." },
  {
    label: "listInNote",
    type: "method",
    detail: "() → Promise<KitAttachment[]>",
    info: "Only attachments referenced (`attach://shortId`) from the CURRENT note's content.",
  },
  snippetCompletion("get(${1:'shortId'})", {
    label: "get",
    type: "method",
    detail: "(shortId) → Promise<KitAttachment | null>",
    info: "Fetch a single attachment by short-id.",
  }),
  snippetCompletion("upload(${1:file})", {
    label: "upload",
    type: "method",
    detail: "(file: File | Blob, filename?) → Promise<KitAttachment>",
    info: "Upload a File or Blob. Filename required for Blob (auto for File).",
  }),
  snippetCompletion("uploadFromPicker(${1:{ multiple: true }})", {
    label: "uploadFromPicker",
    type: "method",
    detail: "({ accept?, multiple? }?) → Promise<KitAttachment[]>",
    info: "Open the browser file picker, upload every picked file.",
  }),
  snippetCompletion("insertIntoContent(${1:'shortId'})", {
    label: "insertIntoContent",
    type: "method",
    detail: "(shortId) → Promise<void>",
    info: "Append `[filename](attach://shortId)` (or `![](…)` for images) to the current note.",
  }),
  snippetCompletion("remove(${1:'shortId'})", {
    label: "remove",
    type: "method",
    detail: "(shortId) → Promise<void>",
    info: "Delete an attachment. Permanent.",
  }),
];

// ── nb.tags ─────────────────────────────────────────────────────
const tagsCompletions: Completion[] = [
  { label: "list", type: "method", detail: "() → Promise<KitTagSummary[]>", info: "All tags in this notebook with note counts." },
  snippetCompletion("notesForTag(${1:'tag'})", {
    label: "notesForTag",
    type: "method",
    detail: "(tag) → Promise<KitNote[]>",
    info: "Find every note in the notebook that references the given tag.",
  }),
];

// ── current.kv ────────────────────────────────────────────────────
const stateCompletions: Completion[] = [
  snippetCompletion("get(${1:'key'})", {
    label: "get",
    type: "method",
    detail: "(key) → T | undefined",
    info: "Sync read from the collaborative Y.Map. Returns undefined if key not set.",
  }),
  snippetCompletion("set(${1:'key'}, (${2:value} = 0) => ${2:value} + 1)", {
    label: "set",
    type: "method",
    detail: "(key, value | updater) → void",
    info: "Sync write. Pass a value or an updater function that receives the current value.",
  }),
  snippetCompletion("delete(${1:'key'})", {
    label: "delete",
    type: "method",
    detail: "(key) → void",
    info: "Sync remove. Syncs to all collaborators.",
  }),
  { label: "keys", type: "method", detail: "() → string[]", info: "All currently-set keys, sorted alphabetically." },
  snippetCompletion("observe(${1:'key'}, (value) => ${2:console.log(value)})", {
    label: "observe",
    type: "method",
    detail: "(key, cb) → unsubscribe()",
    info: "Fire `cb` whenever ANY peer changes the value for `key`. Auto-cleaned on script re-run.",
  }),
];

// ── nb.localKV ───────────────────────────────────────────────
const localKVCompletions: Completion[] = [
  snippetCompletion("get(${1:'key'})", {
    label: "get",
    type: "method",
    detail: "(key) → Promise<T | undefined>",
    info: "Async read from per-user OPFS store.",
  }),
  snippetCompletion("set(${1:'key'}, (${2:value} = 0) => ${2:value} + 1)", {
    label: "set",
    type: "method",
    detail: "(key, value | updater) → Promise<void>",
    info: "Async write. Pass a value or an updater function that receives the current value.",
  }),
  snippetCompletion("delete(${1:'key'})", {
    label: "delete",
    type: "method",
    detail: "(key) → Promise<void>",
    info: "Async remove.",
  }),
  { label: "keys", type: "method", detail: "() → Promise<string[]>", info: "All keys for THIS notebook's namespace." },
  snippetCompletion("observe(${1:'key'}, (value) => ${2:console.log(value)})", {
    label: "observe",
    type: "method",
    detail: "(key, cb) → unsubscribe()",
    info: "Fire `cb` on any change to `key` — same tab and other tabs.",
  }),
];

// ── ui ───────────────────────────────────────────────────────
const uiCompletions: Completion[] = [
  // Layout
  snippetCompletion("row(${1:...children})", {
    label: "row",
    type: "method",
    detail: "(...children) → KitElement",
    info: "Horizontal flex with wrap + gap. Children = KitElement / HTMLElement / string / falsy.",
  }),
  snippetCompletion("col(${1:...children})", {
    label: "col",
    type: "method",
    detail: "(...children) → KitElement",
    info: "Vertical flex with gap.",
  }),
  snippetCompletion("card(${1:...children})", {
    label: "card",
    type: "method",
    detail: "(...children) → KitElement",
    info: "Container with padding — visual grouping.",
  }),
  snippetCompletion("metric(${1:'Daily notes'}, ${2:notes.length}, { icon: '${3:ti ti-notebook}', tone: '${4:info}' })", {
    label: "metric",
    type: "method",
    detail: "(label, value, options?) → KitElement",
    info: "Compact dashboard metric. Prefer this over card(heading(...), text(...)) for KPI-style numbers.",
  }),
  { label: "divider", type: "method", detail: "() → KitElement", info: "Horizontal rule." },
  // Content
  snippetCompletion("text(${1:'content'})", {
    label: "text",
    type: "method",
    detail: "(content) → KitElement",
    info: "Plain text paragraph.",
  }),
  snippetCompletion("heading(${1:'title'}, ${2:2})", {
    label: "heading",
    type: "method",
    detail: "(content, level?) → KitElement",
    info: "h1-h6, default h2.",
  }),
  snippetCompletion("md(${1:'**markdown** here'})", {
    label: "md",
    type: "method",
    detail: "(markdown) → KitElement",
    info: "Render arbitrary markdown using the same engine as notebook content.",
  }),
  snippetCompletion("noteLink(${1:note})", {
    label: "noteLink",
    type: "method",
    detail: "(note | shortId, label?) → KitElement",
    info: "Render a clickable link to a note. Accepts a KitNote or a short-id.",
  }),
  snippetCompletion("noteList(${1:notes})", {
    label: "noteList",
    type: "method",
    detail: "(notes, options?) → KitElement",
    info: "Render a compact vertical list of note links. Options: { emptyText }.",
  }),
  snippetCompletion("table(${1:rows})", {
    label: "table",
    type: "method",
    detail: "(rows, options?) → KitElement",
    info: "Render rows with the same tile table surface as markdown tables. KitNote values become note links; tag arrays become pills.",
  }),
  snippetCompletion(
    "chart('bar', {\n  data: [\n    { label: '${1:Done}', value: ${2:12} },\n    { label: '${3:Open}', value: ${4:5} }\n  ],\n  height: ${5:240}\n})",
    {
      label: "chart",
      type: "method",
      detail: "(kind, options) → KitElement",
      info: "Render a stdlib SVG chart. Width is measured from the output container; pass height in pixels.",
    },
  ),
  // Interactive
  snippetCompletion("button(${1:'label'}, () => ${2:ui.toast('clicked')})", {
    label: "button",
    type: "method",
    detail: "(label, onClick, options?) → KitElement",
    info: "Clickable button. Options: { variant: 'primary'|'secondary'|'danger', icon?: 'ti ti-…', disabled?: boolean }.",
  }),
  // Escape hatch
  snippetCompletion("html(${1:'<div>raw html</div>'})", {
    label: "html",
    type: "method",
    detail: "(rawHtml) → KitElement",
    info: "Wrap raw HTML in a container. Trusted-script-only; no sanitisation.",
  }),
  // Mount
  snippetCompletion("live(() => ${1:ui.table(current.table('ideas')?.rows ?? [])})", {
    label: "live",
    type: "method",
    detail: "(render) → KitElement",
    info: "Render one reactive slot. Re-runs when the current note body changes in edit mode; static one-shot in readonly output.",
  }),
  snippetCompletion("render(${1:...elements})", {
    label: "render",
    type: "method",
    detail: "(...elements) → void",
    info: "Mount elements into the script's output container. Equivalent to calling `.show()` on each.",
  }),
  // Side effects
  snippetCompletion("toast(${1:'description'})", {
    label: "toast",
    type: "method",
    detail: "(description, options?) → void",
    info: "Global toast. Options: { variant: 'default'|'success'|'error', duration, title, iconClass }.",
  }),
  // Modals namespace
  {
    label: "prompt",
    type: "namespace",
    detail: "Modal prompts",
    info: "alert / confirm / text / form — Promise-based.",
  },
];

// ── ui.prompt ────────────────────────────────────────────────
const uiPromptCompletions: Completion[] = [
  snippetCompletion("alert(${1:'message'})", {
    label: "alert",
    type: "method",
    detail: "(message, options?) → Promise<void>",
    info: "Info dialog with OK button.",
  }),
  snippetCompletion("confirm(${1:'Are you sure?'})", {
    label: "confirm",
    type: "method",
    detail: "(message, options?) → Promise<boolean>",
    info: "Yes/No dialog. Resolves true for OK, false for Cancel.",
  }),
  snippetCompletion("text(${1:'Enter value:'}, ${2:''})", {
    label: "text",
    type: "method",
    detail: "(message, default?, options?) → Promise<string | null>",
    info: "Single text input. Returns null on cancel.",
  }),
  snippetCompletion(
    "form({\n  title: '${1:Title}',\n  fields: {\n    ${2:fieldName}: { type: '${3|text,number,boolean,select|}', label: '${4:Label}' }\n  }\n})",
    {
      label: "form",
      type: "method",
      detail: "(spec) → Promise<values | null>",
      info: "Multi-field form modal. Field types: text (with multiline + lines for textarea), number, boolean, select.",
    },
  ),
];

// =============================================================================
// stdlib namespace completions — minimal entry points (most-used per module)
// =============================================================================
//
// We don't try to enumerate every stdlib export — that'd be a maintenance
// burden and out-of-sync risk. Instead each namespace lists the top ~5-10
// most-useful entry points. Users discover the rest via the stdlib docs.

const textCompletions: Completion[] = [
  snippetCompletion("slugify(${1:'input'})", { label: "slugify", type: "method", detail: "(text) → string", info: "URL-safe slug." }),
  snippetCompletion("humanize(${1:'snake_case'})", {
    label: "humanize",
    type: "method",
    detail: "(text) → string",
    info: 'humanize-string → "Snake case".',
  }),
  snippetCompletion("titleify(${1:'lorem ipsum'})", { label: "titleify", type: "method", detail: "(text) → string", info: "Title case." }),
  snippetCompletion("truncate(${1:'long text'}, ${2:80})", {
    label: "truncate",
    type: "method",
    detail: "(text, max) → string",
    info: "Cut + add ellipsis.",
  }),
  snippetCompletion("summarize(${1:'markdown'}, ${2:200})", {
    label: "summarize",
    type: "method",
    detail: "(text, max) → string",
    info: "Strip formatting + truncate.",
  }),
  snippetCompletion("camelCase(${1:'hello-world'})", { label: "camelCase", type: "method", detail: "(text) → string" }),
  snippetCompletion("snakeCase(${1:'helloWorld'})", { label: "snakeCase", type: "method", detail: "(text) → string" }),
  snippetCompletion("kebabCase(${1:'hello World'})", { label: "kebabCase", type: "method", detail: "(text) → string" }),
  snippetCompletion("pascalCase(${1:'hello-world'})", { label: "pascalCase", type: "method", detail: "(text) → string" }),
  snippetCompletion("pprintBytes(${1:1234567})", { label: "pprintBytes", type: "method", detail: "(bytes) → string", info: '"1.23 MB".' }),
];

const datesCompletions: Completion[] = [
  snippetCompletion("formatDate(${1:new Date()})", {
    label: "formatDate",
    type: "method",
    detail: "(date) → string",
    info: 'e.g. "05 Mar 2025".',
  }),
  snippetCompletion("formatDateTime(${1:new Date()})", { label: "formatDateTime", type: "method", detail: "(date) → string" }),
  snippetCompletion("formatDateTimeRelative(${1:new Date()})", {
    label: "formatDateTimeRelative",
    type: "method",
    detail: "(date) → string",
    info: '"3 minutes ago".',
  }),
  snippetCompletion("formatDuration(${1:5400000})", { label: "formatDuration", type: "method", detail: "(ms) → string" }),
  snippetCompletion("getMonthGrid(${1:new Date()})", {
    label: "getMonthGrid",
    type: "method",
    detail: "(date) → Date[][]",
    info: "6-row calendar grid.",
  }),
];

const fuzzyCompletions: Completion[] = [
  snippetCompletion("match(${1:'query'}, ${2:'haystack'})", {
    label: "match",
    type: "method",
    detail: "(query, target) → number",
    info: "Score; higher = better.",
  }),
  snippetCompletion("filter(${1:'query'}, ${2:items}, ${3:(it) => it.title})", {
    label: "filter",
    type: "method",
    detail: "(query, items, getString?) → items[]",
    info: "Sorted by score, non-matches dropped.",
  }),
  snippetCompletion("segments(${1:'query'}, ${2:'haystack'})", {
    label: "segments",
    type: "method",
    detail: "(query, target) → Segment[]",
    info: "Match / non-match segments for highlight rendering.",
  }),
  snippetCompletion("closest(${1:'typo'}, ${2:choices})", {
    label: "closest",
    type: "method",
    detail: "(input, choices) → string | null",
    info: "Edit-distance based typo correction.",
  }),
  snippetCompletion("distance(${1:'a'}, ${2:'b'})", { label: "distance", type: "method", detail: "(a, b) → number", info: "Levenshtein." }),
];

const cryptoCompletions: Completion[] = [
  { label: "common", type: "namespace", detail: "Hash, UUID, IDs, keys", info: "hash, fnv1aHash, uuid, readableId, generateKey." },
  { label: "asymmetric", type: "namespace", detail: "ECDSA + ECDH+AES-GCM", info: "generate, sign / verify, encrypt / decrypt." },
  { label: "symmetric", type: "namespace", detail: "AES-GCM", info: "encrypt / decrypt with password or key." },
  { label: "totp", type: "namespace", detail: "Two-factor auth", info: "create / verify." },
];

const encodingCompletions: Completion[] = [
  snippetCompletion("toBase64(${1:bytes})", { label: "toBase64", type: "method", detail: "(Uint8Array | string) → string" }),
  snippetCompletion("fromBase64(${1:'base64'})", { label: "fromBase64", type: "method", detail: "(string) → Uint8Array" }),
  snippetCompletion("toHex(${1:bytes})", { label: "toHex", type: "method", detail: "(bytes) → string" }),
  snippetCompletion("fromHex(${1:'deadbeef'})", { label: "fromHex", type: "method", detail: "(string) → Uint8Array" }),
  snippetCompletion("toBase62(${1:12345})", {
    label: "toBase62",
    type: "method",
    detail: "(bigint | number) → string",
    info: "URL-safe alphanumeric.",
  }),
  snippetCompletion("fromBase62(${1:'abc'})", { label: "fromBase62", type: "method", detail: "(string) → bigint" }),
];

const chartsCompletions: Completion[] = [
  snippetCompletion("scatter(${1:dataPoints}, ${2:{ width: 400, height: 200 }})", {
    label: "scatter",
    type: "method",
    detail: "(data, options?) → string",
    info: "SVG scatter plot.",
  }),
  snippetCompletion("line(${1:series}, ${2:{ width: 400, height: 200 }})", {
    label: "line",
    type: "method",
    detail: "(data, options?) → string",
  }),
  snippetCompletion("bar(${1:[{label, value}]}, ${2:{ width: 400, height: 200 }})", {
    label: "bar",
    type: "method",
    detail: "(data, options?) → string",
  }),
  snippetCompletion("pie(${1:[{label, value}]})", { label: "pie", type: "method", detail: "(data, options?) → string" }),
  snippetCompletion("donut(${1:[{label, value}]})", { label: "donut", type: "method", detail: "(data, options?) → string" }),
  snippetCompletion("histogram(${1:numbers})", { label: "histogram", type: "method", detail: "(data, options?) → string" }),
  snippetCompletion("boxplot(${1:numbers})", { label: "boxplot", type: "method", detail: "(data, options?) → string" }),
  snippetCompletion("sparkline(${1:numbers})", {
    label: "sparkline",
    type: "method",
    detail: "(data, options?) → string",
    info: "Minimalist inline trend line.",
  }),
];

const qrCompletions: Completion[] = [
  snippetCompletion("wifi(${1:{ ssid: 'name', password: 'pass', security: 'WPA' }})", {
    label: "wifi",
    type: "method",
    detail: "({ ssid, password, security, hidden? }) → string",
    info: "WiFi-config payload string.",
  }),
  snippetCompletion("email(${1:'to@example.com'})", {
    label: "email",
    type: "method",
    detail: "(email, opts?) → string",
    info: "Mailto payload — to, subject, body.",
  }),
  snippetCompletion("tel(${1:'+491234567'})", { label: "tel", type: "method", detail: "(phone) → string" }),
  snippetCompletion("vcard(${1:{ name: 'Alice' }})", {
    label: "vcard",
    type: "method",
    detail: "(contact) → string",
    info: "vCard 3.0 string.",
  }),
  snippetCompletion("event(${1:{ title, start, end }})", {
    label: "event",
    type: "method",
    detail: "(event) → string",
    info: "iCalendar VEVENT payload.",
  }),
  snippetCompletion("toSvg(${1:payload})", {
    label: "toSvg",
    type: "method",
    detail: "(payload, options?) → string",
    info: "Render any QR payload as an SVG string.",
  }),
];

const passwordCompletions: Completion[] = [
  snippetCompletion("random(${1:16})", {
    label: "random",
    type: "method",
    detail: "(length?, options?) → string",
    info: "Cryptographically-random password.",
  }),
  snippetCompletion("memorable(${1:4})", {
    label: "memorable",
    type: "method",
    detail: "(wordCount?, options?) → string",
    info: 'EFF wordlist-based, like "correct-horse-battery-staple".',
  }),
  snippetCompletion("pin(${1:6})", { label: "pin", type: "method", detail: "(length?) → string", info: "Numeric PIN." }),
  snippetCompletion("strength(${1:'password'})", {
    label: "strength",
    type: "method",
    detail: "(password) → { score, feedback }",
    info: "Score 0-4 + actionable feedback.",
  }),
];

const timingCompletions: Completion[] = [
  snippetCompletion("sleep(${1:1000})", { label: "sleep", type: "method", detail: "(ms) → Promise<void>" }),
  snippetCompletion("debounce(${1:fn}, ${2:300})", { label: "debounce", type: "method", detail: "(fn, ms) → debounced" }),
  snippetCompletion("throttle(${1:fn}, ${2:300})", { label: "throttle", type: "method", detail: "(fn, ms) → throttled" }),
  snippetCompletion("jitter(${1:1000}, ${2:0.2})", {
    label: "jitter",
    type: "method",
    detail: "(ms, ratio?) → number",
    info: "Add randomness to a duration.",
  }),
  snippetCompletion("random(${1:0}, ${2:10})", { label: "random", type: "method", detail: "(min?, max?, step?) → number" }),
  snippetCompletion("shuffle(${1:array})", { label: "shuffle", type: "method", detail: "(array) → array", info: "In-place Fisher-Yates." }),
  snippetCompletion("withMinLoadTime(${1:promise}, ${2:500})", {
    label: "withMinLoadTime",
    type: "method",
    detail: "(promise, ms) → Promise<T>",
    info: "Anti-flicker for loading states.",
  }),
];

const filesCompletions: Completion[] = [
  snippetCompletion("downloadFileFromContent(${1:content}, ${2:'name.txt'}, ${3:'text/plain'})", {
    label: "downloadFileFromContent",
    type: "method",
    detail: "(content, filename, mime?) → void",
  }),
  snippetCompletion("createZip(${1:[{ path, content }]})", { label: "createZip", type: "method", detail: "(entries) → Promise<Blob>" }),
  snippetCompletion("downloadAsZip(${1:[{ path, content }]}, ${2:'archive.zip'})", {
    label: "downloadAsZip",
    type: "method",
    detail: "(entries, filename) → Promise<void>",
  }),
  snippetCompletion("showFileDialog(${1:{ accept: '*' }})", {
    label: "showFileDialog",
    type: "method",
    detail: "(opts?) → Promise<File[]>",
  }),
  snippetCompletion("showFolderDialog()", {
    label: "showFolderDialog",
    type: "method",
    detail: "() → Promise<FileSystemDirectoryHandle | null>",
  }),
  snippetCompletion("getMimeType(${1:'file.pdf'})", { label: "getMimeType", type: "method", detail: "(filename) → string | null" }),
  snippetCompletion("getExtension(${1:'application/pdf'})", { label: "getExtension", type: "method", detail: "(mime) → string | null" }),
];

const imagesCompletions: Completion[] = [
  snippetCompletion("create(${1:file})", {
    label: "create",
    type: "method",
    detail: "(File | Blob | string) → Promise<ImgData>",
    info: "Start a pipeline.",
  }),
  snippetCompletion("resize(${1:{ width: 800 }})", {
    label: "resize",
    type: "method",
    detail: "(opts) → step",
    info: "Chain into `.then`.",
  }),
  snippetCompletion("crop(${1:{ x: 0, y: 0, width: 400, height: 400 }})", { label: "crop", type: "method", detail: "(opts) → step" }),
  snippetCompletion("filter(${1:{ brightness: 1.2 }})", { label: "filter", type: "method", detail: "(opts) → step" }),
  snippetCompletion("rotate(${1:90})", { label: "rotate", type: "method", detail: "(degrees) → step" }),
  snippetCompletion("flip(${1:'horizontal'})", { label: "flip", type: "method", detail: "('horizontal' | 'vertical') → step" }),
  { label: "toBlob", type: "method", detail: "(opts?) → step → Promise<Blob>" },
  { label: "toFile", type: "method", detail: "(filename, opts?) → step → Promise<File>" },
  { label: "toBase64", type: "method", detail: "(opts?) → step → Promise<string>" },
  { label: "toCanvas", type: "method", detail: "() → step → Promise<HTMLCanvasElement>" },
  snippetCompletion("batch(${1:files}, ${2:pipeline})", {
    label: "batch",
    type: "method",
    detail: "(items, pipeline, onProgress?) → Promise<T[]>",
  }),
  { label: "presets", type: "namespace", detail: "{ avatar, thumbnail }" },
];

const clipboardCompletions: Completion[] = [
  snippetCompletion("copy(${1:'text'})", {
    label: "copy",
    type: "method",
    detail: "(text) → Promise<void>",
    info: "Copy text to the system clipboard.",
  }),
];

// =============================================================================
// Per-namespace lookup
// =============================================================================

const NAMESPACE_OPTIONS: Record<string, Completion[]> = {
  current: noteCompletions,
  nb: notesCompletions,
  std: [
    ns("text", "ti-typography", "Text manipulation", "slugify, humanize, titleify, truncate, summarize, case conversions, pprintBytes."),
    ns(
      "dates",
      "ti-calendar",
      "Date / time formatting",
      'formatDate, formatDateTime, formatDateTimeRelative ("3 minutes ago"), formatDuration.',
    ),
    ns("fuzzy", "ti-search", "Fuzzy search", "match / filter / segments / closest / distance."),
    ns("crypto", "ti-shield-lock", "Hashing + crypto", "Hashing, ids, asymmetric/symmetric crypto, TOTP."),
    ns("encoding", "ti-binary", "Byte ↔ string", "Base64, Hex, Base62."),
    ns("charts", "ti-chart-bar", "SVG charts", "Low-level SVG chart generators. Prefer `ui.chart(kind, options)` for rendered output."),
    ns("qr", "ti-qrcode", "QR code generators", "Generate payloads and render QR SVGs."),
    ns("password", "ti-key", "Password generation", "random, memorable, pin, strength meter."),
    ns("timing", "ti-clock", "Timing helpers", "sleep, debounce, throttle, jitter, withMinLoadTime."),
    ns("files", "ti-file-download", "File downloads + dialogs", "Downloads, ZIP files, file/folder pickers, MIME helpers."),
    ns("images", "ti-photo", "Image processing", "Resize, crop, filter, rotate, convert."),
    ns("clipboard", "ti-clipboard", "Clipboard", "copy(text)."),
  ],
  ui: uiCompletions,
};

const STANDALONE_NAMESPACE_OPTIONS: Record<string, Completion[]> = {
  current: noteCompletions,
  nb: notesCompletions,
  ui: uiCompletions,
  std: NAMESPACE_OPTIONS.std ?? [],
};

const STD_NAMESPACE_OPTIONS: Record<string, Completion[]> = {
  text: textCompletions,
  dates: datesCompletions,
  fuzzy: fuzzyCompletions,
  crypto: cryptoCompletions,
  encoding: encodingCompletions,
  charts: chartsCompletions,
  qr: qrCompletions,
  password: passwordCompletions,
  timing: timingCompletions,
  files: filesCompletions,
  images: imagesCompletions,
  clipboard: clipboardCompletions,
};

// Two-level namespaces (`ui.prompt.*`, `nb.attachments.*`, ...).
const NESTED_OPTIONS: Record<string, Completion[]> = {
  "current.kv": stateCompletions,
  "nb.attachments": attachmentsCompletions,
  "nb.tags": tagsCompletions,
  "nb.localKV": localKVCompletions,
  "ui.prompt": uiPromptCompletions,
};

// =============================================================================
// Completion source
// =============================================================================

/**
 * Parse `current.<...>`, `nb.<...>`, `ui.<...>`, and `std.<...>`
 * style paths from the user's typed text and
 * return the matching `Completion[]` to offer plus the `from` offset
 * CM should replace from. Returns null when the path doesn't match
 * a known namespace.
 */
const completionsForPath = (word: { from: number; to: number; text: string }, locale?: string): CompletionResult | null => {
  const text = word.text;

  if (/^(?:c(?:u(?:r(?:r(?:e(?:n(?:t)?)?)?)?)?)?|n(?:b)?|u(?:i)?|s(?:t(?:d)?)?)$/.test(text)) {
    return {
      from: word.from,
      options: localizeOptions(
        topLevelCompletions.filter((option) => option.label.startsWith(text)),
        "",
        locale,
      ),
      validFor: /^\w*$/,
    };
  }

  const standalone = text.match(/^(current|nb|ui|std)\.(\w*)$/);
  if (standalone) {
    const [, namespace] = standalone;
    const dotIdx = text.lastIndexOf(".");
    return {
      from: word.from + dotIdx + 1,
      options: localizeOptions(STANDALONE_NAMESPACE_OPTIONS[namespace!] ?? [], namespace!, locale),
      validFor: /^\w*$/,
    };
  }

  const nested = text.match(/^(current|nb|ui)\.(\w+)\.(\w*)$/);
  if (nested) {
    const [, namespace, sub] = nested;
    const opts = NESTED_OPTIONS[`${namespace}.${sub}`];
    if (!opts) return null;
    const dotIdx = text.lastIndexOf(".");
    return {
      from: word.from + dotIdx + 1,
      options: localizeOptions(opts, `${namespace}.${sub}`, locale),
      validFor: /^\w*$/,
    };
  }

  const stdOneLevel = text.match(/^std\.(\w+)\.(\w*)$/);
  if (stdOneLevel) {
    const [, namespace] = stdOneLevel;
    const opts = STD_NAMESPACE_OPTIONS[namespace!];
    if (!opts) return null;
    const dotIdx = text.lastIndexOf(".");
    return {
      from: word.from + dotIdx + 1,
      options: localizeOptions(opts, `std.${namespace}`, locale),
      validFor: /^\w*$/,
    };
  }

  return null;
};

/**
 * Check whether the cursor is currently inside a FencedCode block
 * whose info-string identifies the notebook script language.
 *
 * Without this scope check, script API completion would also fire inside
 * plain markdown text (because `matchBefore` only inspects the
 * characters before the cursor — it doesn't know what kind of
 * region those characters live in). That's leaky UX: users typing
 * a script namespace word in a regular paragraph shouldn't see API
 * completions.
 */
const SCRIPT_LIKE_INFO = new Set(["script"]);

type FenceScopeCache = {
  pos: number;
  result: boolean;
};

const fenceScopeCache = new WeakMap<EditorState, FenceScopeCache>();

export const isInsideScriptLikeFence = (context: CompletionContext): boolean => {
  const cached = fenceScopeCache.get(context.state);
  if (cached?.pos === context.pos) return cached.result;

  const tree = syntaxTree(context.state);
  let node: SyntaxNode | null = tree.resolveInner(context.pos, -1);
  while (node && node.name !== "FencedCode") node = node.parent ?? null;
  if (!node) {
    fenceScopeCache.set(context.state, { pos: context.pos, result: false });
    return false;
  }
  // Walk children to find the CodeInfo node — the language tag.
  let child = node.firstChild;
  while (child) {
    if (child.name === "CodeInfo") {
      const info = context.state.doc.sliceString(child.from, child.to).trim().toLowerCase();
      const result = SCRIPT_LIKE_INFO.has(info);
      fenceScopeCache.set(context.state, { pos: context.pos, result });
      return result;
    }
    child = child.nextSibling;
  }
  fenceScopeCache.set(context.state, { pos: context.pos, result: false });
  return false;
};

/**
 * Completion source for notebook script API paths. Exported as a CompletionSource
 * function (not as an extension) so it can be combined with the
 * slash-command source in a single `autocompletion({ override: […] })`
 * config — see `slash-commands/index.ts` for the integration point.
 *
 * Scoped to `script` fenced code blocks via `isInsideScriptLikeFence`
 * so the completion doesn't leak into regular markdown context.
 *
 * The trigger regex matches identifier paths such as `current.table`,
 * `nb.search`, `ui.prompt.text`, and `std.dates.formatDate`.
 */
export const kitCompletionSource = (context: CompletionContext): CompletionResult | null => {
  const word = context.matchBefore(/\b[A-Za-z_][\w.]*/);
  if (!word) return null;
  if (!isInsideScriptLikeFence(context)) return null;
  const locale = typeof document === "undefined" ? "en" : document.documentElement.lang || "en";
  return completionsForPath(word, locale);
};
