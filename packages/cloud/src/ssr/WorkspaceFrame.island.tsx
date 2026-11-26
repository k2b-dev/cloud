import { attachWorkspaces } from "@k2b/ui/v2";
import { onCleanup, onMount } from "solid-js";
import { readAppWorkspaceLayoutCookie, writeAppWorkspaceLayoutCookie } from "../_internal/app-workspace-state";

/**
 * The frame entry of a `Layout ui="v2"` page: its `Workspace` renders on the server, and this island brings what
 * needs the browser alive (the sidebar's drawer and collapse, `Dialog.confirm`, `useToast`, the grips, the folds of
 * the `Nav`). It renders nothing. A hidden sidebar is kept in the app's workspace cookie, which the layout reads for
 * the next page, so the page comes with the right width.
 */
export default function WorkspaceFrame(props: { appId?: string }) {
  onMount(() => {
    const appId = props.appId;
    const stop = attachWorkspaces({
      onSidebarCollapsedChange: (collapsed) => {
        if (!appId) return;
        const state = readAppWorkspaceLayoutCookie(document.cookie, appId) ?? { version: 2 as const };
        writeAppWorkspaceLayoutCookie(appId, { ...state, sidebarCollapsed: collapsed });
      },
    });
    onCleanup(stop);
  });
  return null;
}
