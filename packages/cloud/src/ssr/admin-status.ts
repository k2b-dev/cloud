import type { Context } from "hono";
import { auth } from "../server/middleware/auth";
import { isAdminUser } from "../shared/account-session";
import { readCodeAdminCounts } from "./code-admin-counts";

/**
 * The sidebar count is a hint: it may delay an admin page by at most this long. Postgres cancels a blocked or slow read
 * after the budget, and the page renders without the count.
 */
export const ADMIN_STATUS_BUDGET_MS = 250;

/** Code's frame badge includes open version approvals and page reports, with a shared breakdown on the Code page. */
export const preloadAdminCodeApprovals = async (c: Context): Promise<void> => {
  if (!(c.req.path === "/admin" || c.req.path.startsWith("/admin/"))) return;
  try {
    const user = c.get("user");
    if (!user || !isAdminUser(user)) return;
    const counts = await readCodeAdminCounts({
      approverUserId: user.id,
      roleContext: { kind: "request", authority: auth.getAuthority(c) },
      timeoutMs: ADMIN_STATUS_BUDGET_MS,
    });
    c.set("adminCodeCounts", counts);
    c.set("adminCodeApprovals", counts.approvals + counts.reports);
  } catch {
    // Nothing about this hint may fail a page: without it, Administration › Code still lists every request.
  }
};
