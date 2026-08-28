import type { EditorView } from "@codemirror/view";

/** Per-editor context made available to every slash command at runtime. */
export type SlashCommandContext = {
  notebookId: string;
  locale?: string;
};

/**
 * One entry in the slash-command registry. Adding a new command = appending
 * one of these to the registry array; no plumbing needed.
 *
 * `run` is invoked AFTER the typed `/<name>` text has been removed from the
 * document, so commands can treat the line as empty (or as whatever it was
 * before the user started typing the slash invocation).
 */
export type SlashCommand = {
  /** Match key — what the user types after `/`. Lowercase, no spaces. */
  name: string;
  /** Display label in the autocomplete popup. */
  label: string;
  /** Tabler-icons class without the leading `ti `, e.g. `ti-h-1`. */
  icon: string;
  /** Section heading in the popup; commands sharing one section group together. */
  section: SlashCommandSection;
  /** Optional one-liner shown after the label. */
  description?: string;
  /**
   * Extra match keys — typing any of these (substring, case-insensitive)
   * surfaces this command. Useful for synonyms (`/img` → "Attach") and
   * naming-convention variants (`/h1` ↔ `/heading1`). Pick aliases that
   * cannot reasonably belong to another future command.
   */
  aliases?: string[];
  /**
   * Optional parameters-suffix matcher. When the user types `/table2x4`,
   * the slash source splits the input into `name = "table"` + `suffix = "2x4"`,
   * runs this regex against the suffix, and if it matches passes the
   * `RegExpMatchArray` to `run(view, ctx, params)`. When the user types
   * just `/table` (no suffix), `params` is `undefined` and the command
   * can fall back to its default behaviour (e.g. open a modal).
   *
   * Examples:
   *   `params: /^([1-6])$/`      → `/h1`-`/h6` valid, `/h0` and `/h7` rejected
   *   `params: /^(\d+)x(\d+)$/`  → `/table2x4` valid, `/tablefoo` rejected
   *   `params: /^(\d+)$/`        → `/list5` valid, `/listfoo` rejected
   *
   * Without this field, the suffix MUST be empty (no chars beyond the
   * name) for the command to match — preserves the original behaviour
   * for non-parameterised commands.
   */
  params?: RegExp;
  /**
   * Whether the command's output stays inline with surrounding text
   * (`true`) or wants to start a fresh line (`false`, default).
   *
   * When `false` and the user invokes the command mid-line (e.g.
   * `some text /table2x4`), the slash source dispatches a leading
   * newline before `run` is invoked. That lifts the inserted block
   * onto its own line without the user having to position the caret
   * manually. Inline commands (`true`) — date inserters, ID
   * generators, tag pickers — skip this and let `run` insert directly
   * at the caret.
   *
   * Default `false` (block) preserves the original behaviour for
   * commands that weren't explicitly flagged.
   */
  inline?: boolean;
  /**
   * What the command does. May be async (e.g. opens a picker dialog).
   * `params` is the captured-groups array from the `params` regex when
   * the typed text included a suffix; `undefined` for the bare-name
   * invocation.
   */
  run: (view: EditorView, ctx: SlashCommandContext, params?: RegExpMatchArray) => void | Promise<void>;
};

export type SlashCommandSection = "Formatting" | "Lists" | "Insert" | "Callouts" | "Navigation";
