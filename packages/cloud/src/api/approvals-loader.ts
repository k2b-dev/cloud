import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { listCapabilities } from "../_internal/registry";
import { resolveAiChatRequestContext } from "../ai/request-context";
import type { ApprovalListQuery, ApprovalPage } from "../contracts/approvals";
import { CapabilityActionCallReviewSchema, capabilityActionPolicy } from "../contracts/capabilities";
import type { AuthContext } from "../server/middleware/auth";
import { listPending, presentPendingApproval } from "../services/approvals/list";
import { logger } from "../services/logging";
import { getLocalizedRuntimeContext } from "../ssr/runtime";

export const loadPendingApprovals = async <T extends AuthContext>(c: Context<T>, query: ApprovalListQuery): Promise<ApprovalPage> => {
  const ctx = await resolveAiChatRequestContext(c);
  if (ctx instanceof Response) throw new HTTPException(403, { res: ctx });
  const page = await listPending({ approverUserId: ctx.ownerUserId, appId: query.app, link: query.link, cursor: query.cursor });
  const apps = getLocalizedRuntimeContext(c).apps;
  const needsPolicy = page.items.some((row) => {
    if (row.storedReview && "sentence" in row.storedReview) return false;
    const review = CapabilityActionCallReviewSchema.safeParse(row.details);
    return review.success && !review.data.ask;
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
      return presentPendingApproval(row, apps, manifest ? capabilityActionPolicy(manifest, row.action) : undefined);
    }),
  };
};
