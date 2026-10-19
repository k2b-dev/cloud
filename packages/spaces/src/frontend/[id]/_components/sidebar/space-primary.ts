import { commandPath } from "@k2b/cloud/contracts/commands";
import { SPACES_DETAIL_NAVIGATION_EVENT, SPACES_DETAIL_STATE_EVENT, type SpacesDetailNavigation } from "../workspace/workspace-events";
import type { SpaceContext } from "./types";

export const spacePrimaryHref = (ctx: Pick<SpaceContext, "query" | "currentView"> & { space: { id: string } }) => {
  const path = `/app/spaces/${ctx.space.id}${ctx.query ? `?${ctx.query}` : ""}`;
  const command = ctx.currentView === "calendar" ? "spaces.event.compose" : "spaces.task.compose";
  const input = { spaceId: ctx.space.id };
  try {
    return commandPath(path, command, input);
  } catch {
    // A long search or filter query exceeds the command link limit; the view alone always fits.
    return commandPath(`/app/spaces/${ctx.space.id}?view=${ctx.currentView}`, command, input);
  }
};

export const syncSpacePrimaryHref = (document: Document, ctx: Parameters<typeof spacePrimaryHref>[0]) => {
  const path = `/app/spaces/${ctx.space.id}`;
  const sync = (url: URL) => {
    if (url.pathname !== path) return;
    document.querySelector("a[data-workspace-primary]")?.setAttribute("href", spacePrimaryHref({ ...ctx, query: url.search.slice(1) }));
  };
  const syncLocation = () => sync(new URL(window.location.href));
  syncLocation();
  const onCommitted = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    const detail: SpacesDetailNavigation = event.detail;
    if (detail.history === "none") sync(new URL(detail.href, window.location.origin));
  };
  window.addEventListener(SPACES_DETAIL_NAVIGATION_EVENT, onCommitted);
  window.addEventListener(SPACES_DETAIL_STATE_EVENT, syncLocation);
  window.addEventListener("popstate", syncLocation);
  return () => {
    window.removeEventListener(SPACES_DETAIL_NAVIGATION_EVENT, onCommitted);
    window.removeEventListener(SPACES_DETAIL_STATE_EVENT, syncLocation);
    window.removeEventListener("popstate", syncLocation);
  };
};

/** Preserve native links before hydration, reloads, and modified clicks. */
export const interceptSpacePrimaryClick = (document: Document, create: () => void) => {
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a");
    if (!anchor?.hasAttribute("data-workspace-primary") || anchor.hasAttribute("download") || (anchor.target && anchor.target !== "_self"))
      return;
    event.preventDefault();
    create();
  };
  document.addEventListener("click", onClick, true);
  return () => document.removeEventListener("click", onClick, true);
};
