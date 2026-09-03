/**
 * Autocomplete für `:::TYPE` Info-Block-Direktiven.
 *
 * Trigger: line starts with three colons optionally followed by a
 * partial type name (`:::`, `:::n`, `:::warn` …). Accepting a
 * suggestion expands to the full block including the closing
 * `:::` marker, with the cursor parked on the body line ready for
 * content entry.
 *
 * Types match exactly what `info-blocks.ts` recognises in its
 * `blockConfig` registry (note / info / success / warning / danger),
 * with the SAME icon glyphs so the autocomplete option-list previews
 * what the rendered block will look like.
 *
 * Scope: only in regular markdown context. We skip inside existing
 * FencedCode blocks — typing `:::` in a code fence body is just
 * literal text, not a directive.
 */
import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  pickedCompletion,
  snippetCompletion,
} from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import { i18n } from "@k2b/stdlib";
import { buildDataBlockTemplate, dataBlockRefSelection } from "./data-block-template";
import { isInsideFencedCode } from "./editor-scope";
import { withIcon } from "./completion-icon";

type BlockEntry = {
  /** The directive name as it appears after the `:::`. */
  name: string;
  /** Short label shown in the option detail. */
  detail: string;
  /** Tabler icon class — mirrors `info-blocks.ts` blockConfig so the
   *  picker preview matches the rendered widget. */
  icon: string;
  /** Data blocks need to insert an `@ref` handle before the directive. */
  kind?: "callout" | "data";
};

/** Source of truth: keep in sync with the `blockConfig` map in
 *  `info-blocks.ts`. We don't import it here to avoid a circular
 *  module dependency (info-blocks imports from `@codemirror/state`
 *  + `@codemirror/view`, nothing else heavy, so it'd technically be
 *  fine — but keeping the registry duplicated and tiny is easier to
 *  read than threading types through). */
const BLOCKS: BlockEntry[] = [
  { name: "note", detail: "Note callout", icon: "ti-chevron-right" },
  { name: "info", detail: "Info callout", icon: "ti-info-circle" },
  { name: "success", detail: "Success callout", icon: "ti-check" },
  { name: "warning", detail: "Warning callout", icon: "ti-alert-circle" },
  { name: "danger", detail: "Danger callout", icon: "ti-alert-hexagon" },
  { name: "data", detail: "Referenceable data block", icon: "ti-database", kind: "data" },
  { name: "query", detail: "Filtered note list or table", icon: "ti-filter" },
  { name: "toc", detail: "Table of contents", icon: "ti-list-details" },
];

const blockHelp = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      note: "Note callout",
      info: "Info callout",
      success: "Success callout",
      warning: "Warning callout",
      danger: "Danger callout",
      data: "Referenceable data block",
      query: "Filtered note list or table",
      toc: "Table of contents",
    },
    de: {
      note: "Hinweisblock",
      info: "Informationsblock",
      success: "Erfolgsblock",
      warning: "Warnungsblock",
      danger: "Gefahrenhinweis",
      data: "Referenzierbarer Datenblock",
      query: "Gefilterte Notizliste oder Tabelle",
      toc: "Inhaltsverzeichnis",
    },
  },
});

/** Snippet template. Does NOT include the leading `:::` because
 *  the `from` position in the CompletionResult below is anchored
 *  AFTER the `:::` the user already typed — CM's prefix-filter
 *  matches the typed name fragment against `label` (e.g. "note"),
 *  and on acceptance only the text between `from` and the cursor
 *  is replaced. So we only need to emit the type name + body + the
 *  closing fence here; the user's typed `:::` stays in place.
 *  `${0}` parks the final cursor on the empty body line. */
export const buildInfoBlockSnippet = (name: string): string => `${name}\n${name === "query" ? "source: notes\n" : ""}\${0}\n:::`;

const COMPLETIONS: Completion[] = BLOCKS.map((b) => {
  if (b.kind === "data") {
    const c: Completion = {
      label: b.name,
      type: "keyword",
      detail: b.detail,
      apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
        const directiveStart = from - 3;
        const insert = buildDataBlockTemplate();
        view.dispatch({
          changes: { from: directiveStart, to, insert },
          selection: dataBlockRefSelection(directiveStart),
          annotations: pickedCompletion.of(_completion),
          userEvent: "input.complete",
        });
        view.focus();
      },
    };
    withIcon(c, b.icon);
    return c;
  }

  const c = snippetCompletion(buildInfoBlockSnippet(b.name), {
    label: b.name,
    type: "keyword",
    detail: b.detail,
  });
  withIcon(c, b.icon);
  return c;
});

/**
 * Completion source. Wire into `autocompletion({override: […]})`.
 */
export const infoBlockCompletionSource = (context: CompletionContext): CompletionResult | null => {
  const word = context.matchBefore(/^:::\w*/);
  if (!word) return null;
  const line = context.state.doc.lineAt(context.pos);
  if (word.from !== line.from) return null;
  if (isInsideFencedCode(context)) return null;
  // CRITICAL: anchor `from` AFTER the typed `:::` so CM's prefix
  // filter compares the user's partial type name (e.g. "su") to the
  // option labels ("success"). If we anchored at the line start the
  // typed text would include `:::` which doesn't prefix-match any
  // option label, and CM would silently drop the entire option list
  // → empty popup → looks broken.
  const t = blockHelp.resolve(typeof document === "undefined" ? ["en"] : [document.documentElement.lang || "en"]).t;
  return {
    from: word.from + 3,
    to: word.to,
    options: COMPLETIONS.map((completion) => ({
      ...completion,
      detail: t[completion.label as keyof typeof t],
    })),
    validFor: /^\w*$/,
  };
};
