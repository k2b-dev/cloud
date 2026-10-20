import { submitAiTurnAction } from "../ai/runtime";
import { aiConversations } from "../ai/store";
import { APP_ACTION_LIMITS } from "../contracts/app-approval";
import { APPROVALS_PAGE_SIZE } from "../contracts/approvals";
import type { AppDeviceActions } from "../services/app-approval";
import { listPending } from "../services/approvals";
import { appActionOffered, appActionSummary, appActionView, pendingApprovalCard } from "../services/approvals/device";

export const createDeviceActions = (appName: (appId: string, locale: string) => string): AppDeviceActions => {
  const view: AppDeviceActions["view"] = async ({ userId, issuer, actionId }) => {
    const { items } = await listPending({ approverUserId: userId, id: actionId, limit: 1 });
    const row = items[0];
    if (!row) return null;
    const mapped = await appActionView(row, { issuer, appName });
    return appActionOffered(mapped, pendingApprovalCard(row, appName)) ? mapped : null;
  };
  return {
    inbox: async ({ userId, issuer }) => {
      const { items, count } = await listPending({ approverUserId: userId, limit: APPROVALS_PAGE_SIZE });
      const views = await Promise.all(items.map((row) => appActionView(row, { issuer, appName })));
      const actions = views
        .filter((mapped, index) => appActionOffered(mapped, pendingApprovalCard(items[index]!, appName)))
        .slice(0, APP_ACTION_LIMITS.inboxActions)
        .map(appActionSummary);
      return { actions, moreActions: Math.max(0, count - actions.length) };
    },
    view,
    decide: async ({ userId, deviceId, issuer, actionId, digest, approved }) => {
      const current = await view({ userId, issuer, actionId });
      if (!current || current.digest !== digest) return false;
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
