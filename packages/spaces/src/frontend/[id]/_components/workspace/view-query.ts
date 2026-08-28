import { apiClient } from "@/api/client";
import { readResponseError } from "../../../lib/response";
import { spaceMessages } from "../../messages";
import type { SpacesViewSnapshot } from "./workspace-types";

export class SpacesViewUnavailableError extends Error {}

export const loadSpacesViewSnapshot = async (href: string, signal: AbortSignal, locale?: string): Promise<SpacesViewSnapshot> => {
  const { t } = spaceMessages.resolve(locale ? [locale] : []);
  const response = await apiClient.workspace.view.$get({ query: { href } }, { init: { signal } });
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    throw new SpacesViewUnavailableError(t.workspaceAccessChanged);
  }
  if (!response.ok) throw new Error(await readResponseError(response, t.workspaceRefreshFailed));
  return response.json();
};
