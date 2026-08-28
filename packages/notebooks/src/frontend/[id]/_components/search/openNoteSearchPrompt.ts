import { openSpotlightSearch } from "@k2b/ui";
import { apiClient } from "@/api/client";
import { notebookWorkspaceMessages } from "../../messages";

type NoteResult = {
  id: string;
  title: string;
};

type SearchResponse = {
  data: Array<{
    note: NoteResult;
    snippet: string | null;
  }>;
  pagination: {
    page: number;
    per_page: number;
    total: number;
    total_pages: number;
    has_next: boolean;
  };
};

const PER_PAGE = 20;

const cleanSnippet = (snippet: string | null): string | undefined =>
  snippet?.replaceAll("\uE000", "").replaceAll("\uE001", "").replace(/\s+/g, " ").trim() || undefined;

export type PickedNote = {
  id: string;
  title: string;
};

type PromptDressing = {
  title: string;
  icon: string;
  placeholder: string;
};

const runNotePrompt = async (notebookId: string, dressing: PromptDressing, locale?: string): Promise<PickedNote | undefined> => {
  const { t } = notebookWorkspaceMessages.resolve(locale ? [locale] : []);
  const selected = await openSpotlightSearch<PickedNote>({
    title: dressing.title,
    icon: dressing.icon,
    placeholder: dressing.placeholder,
    minQueryLength: 1,
    noResultsText: t.noSearchResults,
    resolve: async ({ query, abortSignal }) => {
      const trimmed = query.trim();
      if (trimmed.length === 0) return [];

      const response = await apiClient.search.$get(
        {
          query: { q: trimmed, notebook: notebookId, page: "1", per_page: String(PER_PAGE) },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(t.searchFailed);

      const payload = await response.json();
      return (payload as SearchResponse).data.map((hit) => ({
        value: { id: hit.note.id, title: hit.note.title },
        label: hit.note.title,
        desc: cleanSnippet(hit.snippet),
      }));
    },
  });

  return selected?.value;
};

/** Search prompt used by the global Cmd+Shift+K shortcut and the sidebar
 *  search button — selecting a note navigates to it. */
export const openNoteSearchPrompt = (notebookId: string, notebookName: string, locale?: string): Promise<PickedNote | undefined> => {
  const { t } = notebookWorkspaceMessages.resolve(locale ? [locale] : []);
  return runNotePrompt(notebookId, {
    title: t.searchNotesIn({ notebook: notebookName }),
    icon: "ti ti-notebook",
    placeholder: t.searchNotesPlaceholder,
  }, locale);
};

/** Picker variant used by the editor's "Insert note link" action — wording
 *  makes it clear the picked note will be inserted as a link, not navigated to. */
export const openNoteLinkPrompt = (notebookId: string, locale?: string): Promise<PickedNote | undefined> => {
  const { t } = notebookWorkspaceMessages.resolve(locale ? [locale] : []);
  return runNotePrompt(notebookId, {
    title: t.insertNoteLink,
    icon: "ti ti-connection",
    placeholder: t.searchLinkTarget,
  }, locale);
};

/** Picker variant used by the `/switch` slash command — picks a note to
 *  navigate to (within the current notebook). */
export const openNoteSwitchPrompt = (notebookId: string, locale?: string): Promise<PickedNote | undefined> => {
  const { t } = notebookWorkspaceMessages.resolve(locale ? [locale] : []);
  return runNotePrompt(notebookId, {
    title: t.switchNote,
    icon: "ti ti-arrows-right-left",
    placeholder: t.searchNoteToOpen,
  }, locale);
};
