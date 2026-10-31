import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { listCapabilities } from "../_internal/registry";
import type { ApprovalListQuery, ApprovalPage } from "../contracts/approvals";
import { CapabilityActionReviewPresentationSchema, capabilityActionPolicy } from "../contracts/capabilities";
import { userFromActor } from "../server/actor";
import { getLocale } from "../server/locale";
import { type AuthContext, auth } from "../server/middleware/auth";
import { listPending, presentPendingApproval } from "../services/approvals/list";
import { logger } from "../services/logging";
import { getLocalizedRuntimeContext } from "../ssr/runtime";

export const loadPendingApprovals = async <T extends AuthContext>(c: Context<T>, query: ApprovalListQuery): Promise<ApprovalPage> => {
  const user = userFromActor(c.get("actor"));
  if (!user) throw new HTTPException(403, { message: "Approvals require a user-backed actor." });
  const page = await listPending({
    roleContext: { kind: "request", authority: auth.getAuthority(c) },
    approverUserId: user.id,
    appId: query.app,
    link: query.link,
    cursor: query.cursor,
  });
  const apps = getLocalizedRuntimeContext(c).apps;
  const needsPolicy = page.items.some((row) => {
    if (row.storedReview && "sentence" in row.storedReview) return false;
    const review = CapabilityActionReviewPresentationSchema.safeParse(row.details);
    return review.success && "sentence" in review.data && !review.data.ask;
  });
  const capabilities = needsPolicy
    ? await listCapabilities().catch((error: unknown) => {
        logger("approvals").warn("Approval capability registry unavailable", {
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      })
    : [];
  return {
    ...page,
    items: page.items.map((row) => {
      const manifest = capabilities.find((entry) => entry.appId === row.appId)?.manifest;
      return presentPendingApproval(row, apps, manifest ? capabilityActionPolicy(manifest, row.action) : undefined, getLocale(c));
    }),
  };
};
