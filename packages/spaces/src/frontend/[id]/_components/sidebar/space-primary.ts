import { commandPath } from "@k2b/cloud/contracts/commands";
import type { SpaceContext } from "./types";

/** The command link of a Space's main action: the view's address with its compose command. */
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
