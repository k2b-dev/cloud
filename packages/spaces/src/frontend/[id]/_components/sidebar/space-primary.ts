import { commandPath } from "@k2b/cloud/contracts/commands";
import type { SpaceContext } from "./types";

export const spacePrimaryHref = (ctx: Pick<SpaceContext, "query" | "currentView"> & { space: { id: string } }) =>
  commandPath(
    `/app/spaces/${ctx.space.id}${ctx.query ? `?${ctx.query}` : ""}`,
    ctx.currentView === "calendar" ? "spaces.event.compose" : "spaces.task.compose",
    { spaceId: ctx.space.id },
  );

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
