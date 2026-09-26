import type { Context } from "hono";
import { loadResourceRevision, workspaceRevisionHeader } from "../service/workspace-revision";

/**
 * Tells the writing tab which structure revision its own write produced so the
 * workspace notice stays quiet for it. Read after the commit, so a concurrent
 * foreign write in the same instant is acknowledged along with it; the server
 * validates every later write anyway.
 */
export const acknowledgeWorkspaceWrite = async (c: Context, baseId: string, key: string) => {
  const revision = await loadResourceRevision(baseId, key);
  if (revision) c.header(workspaceRevisionHeader, `${key}=${revision}`);
};
