import { submitAiTurnAction } from "../ai/runtime";
import { aiConversations } from "../ai/store";
import { APP_ACTION_LIMITS, type AppActionSummary } from "../contracts/app-approval";
import { APPROVALS_PAGE_SIZE } from "../contracts/approvals";
import type { AppDeviceActions } from "../services/app-approval";
import { approvals, listPending, loadApprovalActionPolicies, pendingApprovalCard } from "../services/approvals";
import { appActionOffered, appActionSummary, appActionView } from "../services/approvals/device";

/** Pages of open requests one inbox poll reads at most while it skips browser-only questions. */
const INBOX_PAGES = 5;

export const createDeviceActions = (appName: (appId: string, locale: string) => string): AppDeviceActions => {
  const view: AppDeviceActions["view"] = async ({ userId, issuer, actionId }) => {
    const { items } = await listPending({ roleContext: { kind: "cloud_login" }, approverUserId: userId, id: actionId, limit: 1 });
    const row = items[0];
    if (!row) return null;
    const policy = (await loadApprovalActionPolicies([row]))(row);
    const mapped = await appActionView(row, { issuer, appName, policy });
    if (row.kind === "code_version" && (mapped.truncated || !row.canApprove)) return null;
    return appActionOffered(mapped, pendingApprovalCard(row, appName, policy), policy) ? mapped : null;
  };
  return {
    inbox: async ({ userId, issuer }) => {
      // Browser-only questions are skipped, so read on past them. One poll reads at most this many pages of open
      // requests, newest first, which keeps each 5-second poll bounded.
      const actions: AppActionSummary[] = [];
      let count = 0;
      let cursor: string | undefined;
      for (let page = 0; page < INBOX_PAGES && actions.length < APP_ACTION_LIMITS.inboxActions; page += 1) {
        const result = await listPending({
          roleContext: { kind: "cloud_login" },
          approverUserId: userId,
          limit: APPROVALS_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        });
        count = result.count;
        const policyOf = await loadApprovalActionPolicies(result.items);
        for (const row of result.items) {
          const policy = policyOf(row);
          const mapped = await appActionView(row, { issuer, appName, policy });
          if (
            !(row.kind === "code_version" && (mapped.truncated || !row.canApprove)) &&
            appActionOffered(mapped, pendingApprovalCard(row, appName, policy), policy)
          )
            actions.push(appActionSummary(mapped));
          if (actions.length === APP_ACTION_LIMITS.inboxActions) break;
        }
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      return { actions, moreActions: Math.max(0, count - actions.length) };
    },
    view,
    decide: async ({ userId, deviceId, issuer, actionId, digest, approved }) => {
      const current = await view({ userId, issuer, actionId });
      if (!current || current.digest !== digest) return false;
      const record = await approvals.get(actionId, undefined, true);
      if (record?.kind === "code_version") {
        if (approved && current.truncated) return false;
        const result = await approvals.decide(actionId, { approved }, { userId, via: "cloud_login", deviceId });
        return result.ok;
      }
      const pending = await aiConversations.findPendingTurnActionByApproval({ approvalId: actionId, ownerUserId: userId });
      if (!pending) return false;
      const result = await submitAiTurnAction({
        conversationId: pending.conversationId,
        turnId: pending.turnId,
        callId: pending.callId,
        action: { type: "approval_response", approved },
        decidedBy: { userId, via: "cloud_login", deviceId },
        signedInSession: false,
      });
      return result.ok;
    },
  };
};
