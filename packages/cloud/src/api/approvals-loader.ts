import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { resolveAiChatRequestContext } from "../ai/request-context";
import type { ApprovalListQuery, ApprovalPage } from "../contracts/approvals";
import type { AuthContext } from "../server/middleware/auth";
import { listPending, presentPendingApproval } from "../services/approvals/list";
import { getLocalizedRuntimeContext } from "../ssr/runtime";

export const loadPendingApprovals = async <T extends AuthContext>(c: Context<T>, query: ApprovalListQuery): Promise<ApprovalPage> => {
  const ctx = await resolveAiChatRequestContext(c);
  if (ctx instanceof Response) throw new HTTPException(403, { res: ctx });
  const page = await listPending({ approverUserId: ctx.ownerUserId, appId: query.app, link: query.link, cursor: query.cursor });
  const apps = getLocalizedRuntimeContext(c).apps;
  return { ...page, items: page.items.map((row) => presentPendingApproval(row, apps)) };
};
