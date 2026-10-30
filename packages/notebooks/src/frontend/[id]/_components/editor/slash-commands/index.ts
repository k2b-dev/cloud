import type { Extension } from "@codemirror/state";
import { type SlashAction, slashMenu } from "@k2b/editor";
import { buildAttachmentCompletionSource } from "../../../../lib/editor/attachment-autocomplete";
import { codeFenceCompletionSource } from "../../../../lib/editor/code-fence-snippets";
import { infoBlockCompletionSource } from "../../../../lib/editor/info-block-snippets";
import { buildNoteLinkCompletionSource, noteLinkSuggestionsAfterDelete } from "../../../../lib/editor/note-link-autocomplete";
import { tableColumnCompletionSource } from "../../../../lib/editor/table-columns";
import { tableFormulaCompletionSource } from "../../../../lib/editor/table-formulas";
import { buildTagCompletionSource } from "../../../../lib/editor/tag-autocomplete";
import { slashCommands } from "./commands";
import { slashCommandMessages } from "./messages";
import type { SlashCommandContext } from "./types";

/** The Notebook's commands as slash actions of `@k2b/editor`, labelled in the note's locale and bound to its context. */
const slashActions = (ctx: SlashCommandContext): SlashAction[] => {
  const { t } = slashCommandMessages.resolve(ctx.locale ? [ctx.locale] : []);
  return slashCommands.map((command) => ({
    id: command.name,
    name: command.name,
    icon: command.icon,
    label: t.label({ name: command.name, fallback: command.label }),
    description: command.description ? t.description({ name: command.name, fallback: command.description }) : undefined,
    aliases: command.aliases,
    params: command.params,
    inline: command.inline,
    run: (view, params) => command.run(view, ctx, params),
  }));
};

/**
 * The note's one completion popup: slash commands, then the more specific sources. Each source self-scopes with a
 * cheap match before the caret, so the ones that do not apply return nothing and never interfere.
 *
 *   1. slash commands     — `/<…>` at the line start or after a space
 *   2. code-fence picker  — ``` at the line start (Markdown context)
 *   3. notice-card picker — `:::` at the line start (Markdown context)
 *   4. table formulas     — `=NAME` in a cell; table columns inside a formula call's parentheses
 *   5. attachments        — `![[`, before note links, whose `[[` it contains
 *   6. note links, tags   — `[[` and `#<word>` (notebook-wide, async)
 */
export const slashCommandsExtension = (ctx: SlashCommandContext): Extension => [
  slashMenu({
    actions: slashActions(ctx),
    sources: [
      { name: "code-fence", source: codeFenceCompletionSource },
      { name: "notice-card", source: infoBlockCompletionSource },
      { name: "table-formulas", source: tableFormulaCompletionSource },
      { name: "table-columns", source: tableColumnCompletionSource },
      { name: "attachment", source: buildAttachmentCompletionSource(ctx.notebookId) },
      { name: "note-link", source: buildNoteLinkCompletionSource(ctx.notebookId) },
      { name: "tag", source: buildTagCompletionSource(ctx.notebookId) },
    ],
  }),
  noteLinkSuggestionsAfterDelete,
];
