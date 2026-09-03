import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
  pickedCompletion,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { fuzzy } from "@k2b/stdlib";
import { buildAttachmentCompletionSource } from "../../../../lib/editor/attachment-autocomplete";
import { codeFenceCompletionSource } from "../../../../lib/editor/code-fence-snippets";
import { infoBlockCompletionSource } from "../../../../lib/editor/info-block-snippets";
import { buildNoteLinkCompletionSource } from "../../../../lib/editor/note-link-autocomplete";
import { tableColumnCompletionSource } from "../../../../lib/editor/table-columns";
import { tableFormulaCompletionSource } from "../../../../lib/editor/table-formulas";
import { buildTagCompletionSource } from "../../../../lib/editor/tag-autocomplete";
import { slashCommands } from "./commands";
import type { SlashCommand, SlashCommandContext } from "./types";
import { slashCommandMessages } from "./messages";

/**
 * CodeMirror autocomplete adapter that turns `/<name>` typed at line start
 * into a command palette. Keyboard nav (↑↓ ⏎ ⎋) and filter-as-you-type are
 * inherited from `@codemirror/autocomplete`; we only add the trigger pattern
 * and a per-option icon.
 *
 * Section grouping and the per-option `description` (would render on the
 * right) are intentionally NOT passed to CodeMirror — KISS UX: a flat list
 * of icon + label, ordered by the registry's array order.
 */

/**
 * Slash trigger — `/<word>` preceded by either start-of-line OR a
 * whitespace char. The leading non-`/` char (when present) is in
 * capture group 1; the actual typed name is in capture group 2.
 *
 * Mid-line example: in `some text /h1`, the regex matches starting
 * at the space before the slash. We use capture-group positions to
 * compute the `from` for replacement (= the slash position, NOT the
 * whitespace position) so the surrounding text is preserved.
 *
 * `\w*` in the suffix is the loosest possible match — name AND
 * params get concatenated and split later. This means typing
 * `/table2x4` matches at the cursor (suffix = "table2x4"), and our
 * filter logic walks each registered command to see if its name
 * is a prefix and its `params` regex matches the rest.
 */
const SLASH_TRIGGER_REGEX = /(^|\s)\/(\w*)$/;

/** `Completion` extended with the originating command + parsed
 *  params — used by the icon renderer and the apply function. */
type SlashCompletion = Completion & {
  slashCommand: SlashCommand;
  /** Captured `RegExpMatchArray` from the command's `params` regex,
   *  if the typed text included a parsed suffix. Otherwise undefined. */
  parsedParams?: RegExpMatchArray;
};

/**
 * Decide whether (and how) a command matches the typed text by
 * EXACT name/alias or by PARAMS regex.
 *
 *   - EXACT match — typed text === command name (or any alias).
 *     Returns `{ params: undefined }`.
 *
 *   - PARAMS match — command has a `params` regex AND typed text
 *     starts with the command name AND the regex matches the
 *     remaining suffix. Returns `{ params: <RegExpMatchArray> }`.
 *
 * Returns `null` for everything else — that goes through the fuzzy
 * pipeline below.
 */
const matchExact = (cmd: SlashCommand, typed: string): { params?: RegExpMatchArray } | null => {
  const lower = typed.toLowerCase();
  if (lower === cmd.name.toLowerCase()) return { params: undefined };
  if (cmd.aliases?.some((a) => a.toLowerCase() === lower)) return { params: undefined };
  if (cmd.params && lower.startsWith(cmd.name.toLowerCase())) {
    const suffix = typed.slice(cmd.name.length);
    if (suffix.length > 0) {
      const m = cmd.params.exec(suffix);
      if (m) return { params: m };
    }
  }
  return null;
};

/**
 * Build a haystack string for fuzzy matching. We concat name +
 * label + aliases joined by spaces so the fuzzy subsequence matcher
 * can match against any of them. The order matters slightly — name
 * first means a query like "h1" prefers commands whose name starts
 * with "h1" over commands whose alias merely contains it.
 *
 * Pre-built per command at module load — the result is constant per
 * command instance, no point re-allocating on every keystroke.
 */
const commandHaystacks = new WeakMap<SlashCommand, string>();
const getHaystack = (cmd: SlashCommand): string => {
  const cached = commandHaystacks.get(cmd);
  if (cached !== undefined) return cached;
  const built = [cmd.name, cmd.label, ...(cmd.aliases ?? [])].join(" ");
  commandHaystacks.set(cmd, built);
  return built;
};

/**
 * Minimum fuzzy score to surface a command in the autocomplete.
 * stdlib's fuzzy gives scores roughly in the 0-100 range — too low
 * a threshold lets random subsequence matches pollute the list
 * (typing "h" would surface every command containing an 'h'
 * somewhere). 25 is the sweet spot empirically: rejects accidental
 * matches but accepts typo-friendly matches like "headng" → "Heading".
 */
const FUZZY_MIN_SCORE = 25;

const buildCompletion = (cmd: SlashCommand, ctx: SlashCommandContext, parsedParams?: RegExpMatchArray): SlashCompletion => ({
  label: `/${cmd.name}`,
  displayLabel: cmd.label,
  // Map the registry's `description` field onto CM's standard
  // `detail` field — that's what the `descRenderer` in this file
  // reads. Without this, every slash command popup option shows
  // only the icon + label, hiding the power-cmd hints (e.g.
  // `/table2x4 for direct sizing`) that make those features
  // discoverable.
  detail: cmd.description,
  slashCommand: cmd,
  parsedParams,
  apply: (view, _completion, from, to) => {
    // 1. Strip the typed `/<name>[<suffix>]`. If the command is
    //    block-level AND we're mid-line (= there's non-whitespace
    //    text before our `from`), prepend a newline so the inserted
    //    content lands on a fresh line. The newline replaces the
    //    deleted typed text, then `run` operates on a clean line.
    //
    //    "Mid-line" check: look at the line up to `from` — if it
    //    has any non-whitespace char after trimming, we're not
    //    at line start.
    const line = view.state.doc.lineAt(from);
    const beforeOnLine = line.text.slice(0, from - line.from);
    const isMidLine = beforeOnLine.trim().length > 0;
    const needsNewline = isMidLine && !cmd.inline;
    view.dispatch({
      changes: { from, to, insert: needsNewline ? "\n" : "" },
      annotations: pickedCompletion.of(_completion),
      userEvent: "input.complete",
    });
    // 2. Defer the command's own dispatch(es) to the next microtask.
    //    Running them inline causes CM's autocomplete update + our
    //    `cmd.run` to interleave; for commands that open a modal
    //    (`/note`, `/switch`, `/table`) the resulting re-entrancy
    //    can pin the main thread long enough to trip the browser's
    //    "page unresponsive" warning.
    queueMicrotask(() => {
      void cmd.run(view, ctx, parsedParams);
    });
  },
});

const buildSlashSource = (ctx: SlashCommandContext) => {
  const { t } = slashCommandMessages.resolve(ctx.locale ? [ctx.locale] : []);
  const commands = slashCommands.map((command) => ({
    ...command,
    label: t.label({ name: command.name, fallback: command.label }),
    description: command.description ? t.description({ name: command.name, fallback: command.description }) : undefined,
  }));
  return (context: CompletionContext): CompletionResult | null => {
    // matchBefore is not used here because we want to match the
    // FIRST slash that has only word-chars after it up to the
    // cursor — anchored to either start-of-line or whitespace.
    // The exec call against the line prefix gives us both the
    // optional leading whitespace and the typed name in one pass.
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const match = SLASH_TRIGGER_REGEX.exec(before);
    if (!match) return null;

    const leadingWs = match[1] ?? "";
    const typed = match[2] ?? "";
    // `from` = position of the `/` itself (skip any leading
    // whitespace captured in group 1).
    const fromPos = line.from + match.index + leadingWs.length;

    // Filter & rank:
    //
    //  - EMPTY input  → all commands, registry order
    //  - EXACT / PARAMS matches → always first, then
    //  - FUZZY matches → ranked by stdlib's fuzzy score (subsequence
    //    + bonuses for word-start matches), typo-tolerant
    //
    // Exact / params matches "win" over fuzzy even if a fuzzy score
    // is high — typing `/h1` should ALWAYS surface the h1 command
    // at the top, never some unrelated command that happens to
    // subsequence-match "h1".
    const options: SlashCompletion[] = [];
    if (typed.length === 0) {
      for (const cmd of commands) options.push(buildCompletion(cmd, ctx));
    } else {
      // Pass 1 — exact / params. Skip cmds that match here when
      // pass 2 runs so they don't double-appear.
      const matchedSet = new WeakSet<SlashCommand>();
      for (const cmd of commands) {
        const m = matchExact(cmd, typed);
        if (!m) continue;
        options.push(buildCompletion(cmd, ctx, m.params));
        matchedSet.add(cmd);
      }
      // Pass 2 — fuzzy. Filter the remaining commands by score,
      // sort descending, then append.
      const fuzzyHits = fuzzy.filter(
        typed,
        commands.filter((c) => !matchedSet.has(c)),
        {
          key: getHaystack,
        },
      );
      for (const hit of fuzzyHits) {
        if (hit.score < FUZZY_MIN_SCORE) continue;
        options.push(buildCompletion(hit.item, ctx));
      }
    }

    return {
      from: fromPos,
      to: context.pos,
      filter: false, // we hand back already-filtered options above
      options,
    };
  };
};

/** Default Tabler icons for completion entries without an explicit icon. */
const COMPLETION_TYPE_ICONS: Record<string, string> = {
  method: "ti-math-function",
  function: "ti-math-function",
  property: "ti-circle-dot",
  namespace: "ti-category",
  class: "ti-cube",
  keyword: "ti-braces",
  constant: "ti-pennant",
  variable: "ti-variable",
};

/** Prefer the command icon, then an explicit icon, then the completion type. */
const resolveIcon = (completion: Completion): string => {
  const slashCmd = (completion as SlashCompletion).slashCommand;
  if (slashCmd?.icon) return slashCmd.icon;
  const completionIcon = (completion as Completion & { completionIcon?: string }).completionIcon;
  if (completionIcon) return completionIcon;
  if (completion.type && COMPLETION_TYPE_ICONS[completion.type]) return COMPLETION_TYPE_ICONS[completion.type]!;
  return "ti-command";
};

/** Per-option icon renderer. CM merges this into the default option layout
 *  at the configured `position` slot (label sits at 50). */
const iconRenderer = {
  position: 20,
  render: (completion: Completion): Node => {
    const el = document.createElement("i");
    el.className = `ti ${resolveIcon(completion)} cm-slash-icon`;
    return el;
  },
};

/** Per-option description renderer. Pulls the `detail` (short
 *  signature / one-liner) and renders it inline next to the label
 *  so users can scan API entries without opening the side info
 *  panel. Position 70 places it AFTER the label (which is at 50)
 *  but BEFORE the standard detail slot (which we hide via CSS).
 *  Returns an empty span when there's no detail so CM keeps the
 *  layout consistent. */
const descRenderer = {
  position: 70,
  render: (completion: Completion): Node => {
    const detail = completion.detail;
    if (!detail) return document.createElement("span");
    const el = document.createElement("span");
    el.className = "cm-completion-detail";
    el.textContent = detail;
    return el;
  },
};

/**
 * Wrap a completion source so a sync throw is caught and turned into
 * a `null` result. Without this, ONE crashing source aborts CM's
 * entire autocomplete query — losing slash commands and
 * everything else in the override list. The wrapper preserves async
 * sources transparently (Promise rejections are caught via
 * `.catch`).
 *
 * Errors are routed through `console.error` (not swallowed) so
 * regressions are visible in DevTools.
 */
const safe = (name: string, source: CompletionSource): CompletionSource => {
  return (context: CompletionContext) => {
    try {
      const result = source(context);
      if (result && typeof (result as Promise<unknown>).then === "function") {
        return (result as Promise<CompletionResult | null>).catch((err) => {
          console.error(`[autocomplete:${name}]`, err);
          return null;
        });
      }
      return result;
    } catch (err) {
      console.error(`[autocomplete:${name}]`, err);
      return null;
    }
  };
};

/**
 * Public extension factory. Wire it into the editor with the per-note
 * context so commands like `/note` and `/switch` know which notebook /
 * note they're operating on.
 */
export const slashCommandsExtension = (ctx: SlashCommandContext): Extension =>
  autocompletion({
    // We use `override` to keep CM autocomplete fully under our
    // control (no built-in word completions). That means EVERY
    // completion source we want active has to live in this array.
    //
    // Order matters: CM merges results from all sources that match
    // at the same position, but each source decides its own `from`
    // anchor — so the practical ordering is "more specific first":
    //
    //   1. slash commands     — only at line-start, `/<…>`
    //   2. code-fence picker  — only at line-start, `\`\`\`<…>` (markdown ctx)
    //   3. notice-card picker — only at line-start, `:::<…>` (markdown ctx)
    //   4. table formulas     — only in `|...|` rows, cell starts with `=`
    //   5. tag completion     — `#<word>` mid-text (notebook-wide tags, async)
    //
    // Each source self-scopes via a cheap matchBefore + optional
    // syntax-tree check, so the ones that don't apply return `null`
    // immediately and don't interfere with each other.
    //
    // `safe(...)` wraps each source so a sync throw in ONE source
    // (e.g. a malformed regex, an unexpected state shape) returns
    // `null` for that source instead of bubbling up and aborting
    // the entire autocomplete query — without the wrapper, one
    // bad source blanks out the whole popup including slash
    // commands. Errors are logged so we can diagnose, not
    // silently swallowed.
    override: [
      safe("slash", buildSlashSource(ctx)),
      safe("code-fence", codeFenceCompletionSource),
      safe("notice-card", infoBlockCompletionSource),
      // table-formulas fires when typing `=NAME` in a cell;
      // table-columns fires when typing INSIDE the parens of a
      // formula call. They never both match the same position so
      // their order doesn't change behaviour, but listing
      // formulas first keeps the array ordered by trigger char.
      safe("table-formulas", tableFormulaCompletionSource),
      safe("table-columns", tableColumnCompletionSource),
      // attachment source FIRST because its trigger `![[` is a
      // strict superset of note-link's `[[` — if note-link runs
      // first and accepts a match on the inner `[[`, the attachment
      // popup never fires. The two sources never conflict otherwise
      // (note-link's matchBefore explicitly requires `[[`, not `![[`).
      safe("attachment", buildAttachmentCompletionSource(ctx.notebookId)),
      safe("note-link", buildNoteLinkCompletionSource(ctx.notebookId)),
      safe("tag", buildTagCompletionSource(ctx.notebookId)),
    ],
    activateOnTyping: true,
    selectOnOpen: true,
    closeOnBlur: true,
    icons: false, // we render our own icon via addToOptions
    addToOptions: [iconRenderer, descRenderer],
  });
