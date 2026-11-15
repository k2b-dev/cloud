import type { Context } from "hono";
import { auth } from "../server/middleware/auth";
import { countPending } from "../services/approvals/list";
import { isAdminUser } from "../shared/account-session";
import { countOpenCodePageReports } from "./code-page-reports-count";

/**
 * The sidebar count is a hint: it may delay an admin page by at most this long. Postgres cancels a blocked or slow read
 * after the budget, and the page renders without the count.
 */
export const ADMIN_STATUS_BUDGET_MS = 250;

/**
 * What waits for admins in Administration › Code for the sidebar: open Code-version approvals and open page reports,
 * read once per admin page like the rail snapshot. Both reads run side by side within one budget; without either,
 * the count is left out rather than shown too low.
 */
export const preloadAdminCodeApprovals = async (c: Context): Promise<void> => {
  if (!(c.req.path === "/admin" || c.req.path.startsWith("/admin/"))) return;
  try {
    const user = c.get("user");
    if (!user || !isAdminUser(user)) return;
    const [counts, reports] = await Promise.all([
      countPending({
        approverUserId: user.id,
        roleContext: { kind: "request", authority: auth.getAuthority(c) },
        kind: "code_version",
        timeoutMs: ADMIN_STATUS_BUDGET_MS,
      }),
      countOpenCodePageReports(ADMIN_STATUS_BUDGET_MS),
    ]);
    c.set("adminCodeApprovals", counts.total + reports);
  } catch {
    // Nothing about this hint may fail a page: without it, Administration › Code still lists every request.
  }
};
