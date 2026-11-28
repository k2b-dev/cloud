import { notebooksService } from "@/service";
import { parseLastNotebookId } from "./[id]/_components/settings/NotebookSettingsStore";

/** The notebook used last while this person still reaches it through a grant: that one notebook and its access. */
const lastReached = async (userId: string, shortId: string | null) => {
  const notebook = shortId ? await notebooksService.notebook.getByShortId({ shortId }) : null;
  if (!notebook) return null;
  return (await notebooksService.notebook.permission.get({ notebookId: notebook.id, userId })) === "none" ? null : notebook.shortId;
};

/** The first notebook this person reaches, by name: one row, not every notebook. */
const firstReached = async (userId: string) =>
  (await notebooksService.notebook.list({ userId, pagination: { page: 1, perPage: 1 } })).items[0]?.shortId ?? null;

/**
 * The notebook `/app/notebooks` opens for this person: the one they used last (the settings cookie) while they still
 * reach it, else the first they reach by name; null for a person without any notebook, who sees the first start.
 */
export const startTarget = async (userId: string, cookie: string | undefined): Promise<string | null> =>
  (await lastReached(userId, parseLastNotebookId(cookie))) ?? (await firstReached(userId));
