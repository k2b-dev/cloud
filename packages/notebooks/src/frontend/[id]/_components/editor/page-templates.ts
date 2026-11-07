import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { prompts, toast } from "@k2b/ui";
import { apiClient } from "@/api/client";
import { isBlankPage, type PageTemplateSummary, pageTemplateBody } from "@/lib/page-templates";
import { notebookWorkspaceMessages } from "../../messages";
import { readErrorMessage } from "../settings/utils";

const messages = (locale?: string) => notebookWorkspaceMessages.resolve(locale ? [locale] : []).t;

/** A blank note is short, so a long one is never read whole to find out. */
const BLANK_NOTE_MAX_LENGTH = 1024;

/** Whether the note holds at most its title, so the empty-note offer shows. */
export const isBlankNoteText = (text: string | Text): boolean => text.length <= BLANK_NOTE_MAX_LENGTH && isBlankPage(text.toString());

/** The templates of the notebook, its own first; the server checks the person may read it. */
export const loadPageTemplates = async (notebookId: string, signal?: AbortSignal): Promise<PageTemplateSummary[]> => {
  const res = await apiClient[":id"]["page-templates"].$get({ param: { id: notebookId } }, { init: { signal } });
  if (!res.ok) throw new Error(await readErrorMessage(res, messages().failedLoadTemplates));
  return await res.json();
};

/** The template's Markdown as the server fills it in for this person: their date and their name. */
export const loadPageTemplateDraft = async (notebookId: string, templateId: string, locale?: string): Promise<string> => {
  const res = await apiClient[":id"]["page-templates"][":templateId"].draft.$get({ param: { id: notebookId, templateId } });
  if (!res.ok) throw new Error(await readErrorMessage(res, messages(locale).failedApplyTemplate));
  return (await res.json()).contentMd;
};

/**
 * Puts a template into the note as one undoable change, so collaborators see it like any typing. A note that holds at
 * most its title becomes the template, title included, with the title selected to type over; inside a note with
 * content, the template's body lands at the caret on lines of its own.
 */
export const applyPageTemplate = (view: EditorView, contentMd: string): void => {
  const { state } = view;
  if (isBlankPage(state.doc.toString())) {
    const firstLine = contentMd.split("\n", 1)[0] ?? "";
    const marker = /^#\s+/.exec(firstLine);
    view.dispatch({
      changes: { from: 0, to: state.doc.length, insert: contentMd },
      selection: marker ? { anchor: marker[0].length, head: firstLine.length } : { anchor: 0 },
      scrollIntoView: true,
      userEvent: "input.template",
    });
    view.focus();
    return;
  }
  const body = pageTemplateBody(contentMd).replace(/\n+$/, "");
  const { from, to } = state.selection.main;
  const line = state.doc.lineAt(from);
  // A blank line always separates the sections from the text above, so they never join its paragraph.
  const lineAbove = line.number > 1 ? state.doc.line(line.number - 1).text : "";
  const before = from !== line.from ? "\n\n" : line.text.trim() || lineAbove.trim() ? "\n" : "";
  const after = to === state.doc.lineAt(to).to && to === state.doc.length ? "\n" : "\n\n";
  const insert = `${before}${body}${after}`;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
    scrollIntoView: true,
    userEvent: "input.template",
  });
  view.focus();
};

/** Loads, fills in and applies one template; a failure says so and leaves the note as it was. */
export const applyPageTemplateById = async (view: EditorView, notebookId: string, template: PageTemplateSummary, locale?: string) => {
  try {
    const draft = await loadPageTemplateDraft(notebookId, template.id, locale);
    // The note may have closed, locked or lost its write access while the draft loaded; a script change would still apply.
    if (!view.dom.isConnected || view.state.readOnly) return;
    applyPageTemplate(view, draft);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : messages(locale).failedApplyTemplate);
  }
};

/** The template picker of `/template`: type to filter, Enter to apply. */
export const pickPageTemplate = async (notebookId: string, locale?: string): Promise<PageTemplateSummary | undefined> => {
  const t = messages(locale);
  let loaded: Promise<PageTemplateSummary[]> | undefined;
  const choice = await prompts.search<PageTemplateSummary>(
    async ({ query }) => {
      // One small list per picker; a typed query only filters it.
      loaded ??= loadPageTemplates(notebookId).catch((error: unknown) => {
        loaded = undefined;
        throw error;
      });
      const needle = query.trim().toLocaleLowerCase(locale);
      return (await loaded)
        .filter((template) => !needle || template.name.toLocaleLowerCase(locale).includes(needle))
        .map((template) => ({
          id: template.id,
          value: template,
          label: template.name,
          desc: template.description ?? (template.builtIn ? undefined : t.ownTemplates),
          icon: template.icon,
        }));
    },
    {
      title: t.useTemplate,
      icon: "ti ti-template",
      placeholder: t.searchTemplates,
      noResultsText: t.noTemplateMatch,
      minQueryLength: 0,
      size: "small",
    },
  );
  return choice?.value;
};
