import { type AppWorkspaceLayoutState, parseAppWorkspaceLayoutState, serializeAppWorkspaceLayoutState } from "@k2b/ui";

const safeAppId = (appId: string): string => appId.replace(/[^A-Za-z0-9_-]/g, "_");

export const appWorkspaceCookieName = (appId: string): string => `cloud_workspace_${safeAppId(appId)}`;

export const readAppWorkspaceLayoutCookie = (
  cookieHeader: string | null | undefined,
  appId: string | null | undefined,
): AppWorkspaceLayoutState | null => {
  if (!cookieHeader || !appId) return null;
  const name = appWorkspaceCookieName(appId);
  const encoded = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  return parseAppWorkspaceLayoutState(encoded);
};

export const resolveAppWorkspaceLayoutForSidebar = (
  state: AppWorkspaceLayoutState | null,
  collapsible: boolean | undefined,
): AppWorkspaceLayoutState | null => (collapsible === false && state?.sidebarCollapsed ? { ...state, sidebarCollapsed: false } : state);

/** Keeps an app's workspace layout for a year, so the next page renders it from the server (browser only). */
export const writeAppWorkspaceLayoutCookie = (appId: string, state: AppWorkspaceLayoutState): void => {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${appWorkspaceCookieName(appId)}=${serializeAppWorkspaceLayoutState(state)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
};
