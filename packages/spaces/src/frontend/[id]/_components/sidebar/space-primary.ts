import { commandPath } from "@k2b/cloud/contracts/commands";
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

/** Preserve native links before hydration, reloads, and modified clicks. */
export const interceptSpacePrimaryClick = (document: Document, href: string, create: () => void) => {
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a");
    if (anchor?.getAttribute("href") !== href || anchor.hasAttribute("download") || (anchor.target && anchor.target !== "_self")) return;
    event.preventDefault();
    create();
  };
  document.addEventListener("click", onClick, true);
  return () => document.removeEventListener("click", onClick, true);
};
