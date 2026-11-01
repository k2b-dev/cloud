import type { Context } from "hono";
import { auth } from "../server/middleware/auth";
import { countPending } from "../services/approvals/list";
import { isAdminUser } from "../shared/account-session";

/** Open Code-version approvals for the Administration sidebar; read once per admin page like the rail snapshot. */
export const preloadAdminCodeApprovals = async (c: Context): Promise<void> => {
  const user = c.get("user");
  if (!user || !isAdminUser(user) || !(c.req.path === "/admin" || c.req.path.startsWith("/admin/"))) return;
  try {
    const counts = await countPending({
      approverUserId: user.id,
      roleContext: { kind: "request", authority: auth.getAuthority(c) },
      kind: "code_version",
    });
    c.set("adminCodeApprovals", counts.total);
  } catch {
    // A failed read only hides the count; Administration › Code still lists every request.
  }
};
