import { apiClient } from "@/api/client";
import type { Notebook } from "./types";
import { notebookWorkspaceMessages } from "../../messages";

type NotebookListResponse = {
  data: Notebook[];
  pagination: {
    page: number;
    per_page: number;
    total: number;
    total_pages: number;
    has_next: boolean;
  };
};

const PER_PAGE = 100;
const MAX_PAGES = 20;

/**
 * Fetches all notebooks the current user can access for the sidebar switcher.
 */
export const listAccessibleNotebooks = async (locale = document.documentElement.lang): Promise<Notebook[]> => {
  const t = notebookWorkspaceMessages.resolve([locale]).t;
  const notebooks: Notebook[] = [];
  let page = 1;

  while (page <= MAX_PAGES) {
    const res = await apiClient.index.$get({
      query: { page: String(page), per_page: String(PER_PAGE) },
    });
    if (!res.ok) {
      const error = (await res.json()) as { message?: string };
      throw new Error(error.message ?? t.listNotebooksFailed);
    }

    const payload = (await res.json()) as NotebookListResponse;
    notebooks.push(...payload.data);

    if (!payload.pagination.has_next) break;
    page += 1;
  }

  return notebooks;
};
