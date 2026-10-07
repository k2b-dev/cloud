import { fileTab, workspaceSelectionHref } from "../artifacts/workspace-state";

/** The chat's working folder: Cloud serves nothing below it, and the manifest lists its files only as counts. */
const WORKING_FOLDER = "/temp/";

/**
 * File identity comes from the current chat manifest, never a path prefix, except below the chat's working folder:
 * such a path names a chat file and nothing else, so it opens in the workspace, which reports a file that is gone.
 */
export function resolveChatFileLink(href: string, currentHref: string, conversationId: string, paths: readonly string[]) {
  try {
    const current = new URL(currentHref);
    const target = new URL(href, current);
    if (target.origin !== current.origin || !["http:", "https:"].includes(target.protocol)) return null;
    const pathname = !target.search && !target.hash ? decodeURIComponent(target.pathname) : null;
    const path = paths.includes(href)
      ? href
      : pathname !== null
        ? (paths.find((path) => path === target.pathname || path === pathname) ??
          (pathname.startsWith(WORKING_FOLDER) && !pathname.endsWith("/") ? pathname : undefined))
        : undefined;
    if (!path) return null;
    current.pathname = "/app/assistant";
    current.search = new URLSearchParams({ conversation: conversationId }).toString();
    current.hash = "";
    return { path, href: workspaceSelectionHref(current.href, fileTab(conversationId, path)) };
  } catch {
    return null;
  }
}
