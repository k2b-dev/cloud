import type { Context } from "hono";
import { auth } from "../server/middleware/auth";
import { countPending } from "../services/approvals/list";
import { isAdminUser } from "../shared/account-session";

/**
 * The sidebar count is a hint: it may delay an admin page by at most this long. Postgres cancels a blocked or slow read
 * after the budget, and the page renders without the count.
 */
export const ADMIN_STATUS_BUDGET_MS = 250;

/** Open Code-version approvals for the Administration sidebar; read once per admin page like the rail snapshot. */
export const preloadAdminCodeApprovals = async (c: Context): Promise<void> => {
  const user = c.get("user");
  if (!user || !isAdminUser(user) || !(c.req.path === "/admin" || c.req.path.startsWith("/admin/"))) return;
  try {
    const counts = await countPending({
      approverUserId: user.id,
      roleContext: { kind: "request", authority: auth.getAuthority(c) },
      kind: "code_version",
      timeoutMs: ADMIN_STATUS_BUDGET_MS,
    });
    c.set("adminCodeApprovals", counts.total);
  } catch {
    // A failed read only hides the count; Administration › Code still lists every request.
  }
};
