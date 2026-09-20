import { fileTab, workspaceSelectionHref } from "../artifacts/workspace-state";

/** File identity comes from the current chat manifest, never a path prefix. */
export function resolveChatFileLink(href: string, currentHref: string, conversationId: string, paths: readonly string[]) {
  try {
    const current = new URL(currentHref);
    const target = new URL(href, current);
    if (target.origin !== current.origin || !["http:", "https:"].includes(target.protocol)) return null;
    const path = paths.includes(href) ? href
      : !target.search && !target.hash
        ? paths.find(path => path === target.pathname || path === decodeURIComponent(target.pathname))
        : undefined;
    if (!path) return null;
    current.pathname = "/app/assistant";
    current.search = new URLSearchParams({ conversation: conversationId }).toString();
    current.hash = "";
    return { path, href: workspaceSelectionHref(current.href, fileTab(conversationId, path)) };
  } catch { return null; }
}
