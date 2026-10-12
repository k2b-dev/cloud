import { apiClient } from "@/api/client";
import { readResponseError } from "../../../lib/response";
import { spaceMessages } from "../../messages";
import type { CalendarRange } from "../calendar/range";
import type { SpacesViewSnapshot } from "./workspace-types";

export class SpacesViewUnavailableError extends Error {}

export const loadSpacesViewSnapshot = async (
  href: string,
  signal: AbortSignal,
  locale?: string,
  /** Day and week views: the days to load instead of the first window; a week loaded while scrolling leaves out the tray. */
  range?: CalendarRange & { includeTray?: "false" },
): Promise<SpacesViewSnapshot> => {
  const { t } = spaceMessages.resolve(locale ? [locale] : []);
  const response = await apiClient.workspace.view.$get({ query: { href, ...range } }, { init: { signal } });
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    throw new SpacesViewUnavailableError(t.workspaceAccessChanged);
  }
  if (!response.ok) throw new Error(await readResponseError(response, t.workspaceRefreshFailed));
  return response.json();
};
