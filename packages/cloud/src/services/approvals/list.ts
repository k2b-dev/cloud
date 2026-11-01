import { type AiStoredActionReview, storedActionReview } from "../../ai/action-review";
import { AI_WEBSITE_APPROVAL_TOOL, aiTurnAllowsRememberedApprovals } from "../../ai/approvals";
import type { AiTurnRunConfig } from "../../ai/types";
import { approvalMessages } from "../../approvals/messages";
import type { RuntimeAppMeta } from "../../contracts/app";
import { APPROVALS_PAGE_SIZE, type ApprovalCounts, type PendingApproval } from "../../contracts/approvals";
import { type CapabilityActionPolicy, CapabilityActionReviewPresentationSchema } from "../../contracts/capabilities";
import { sql } from "../../runtime/clients";
import { DEFAULT_LOCALE } from "../../server/locale";
import type { ApprovalAssurance, ApprovalKind } from ".";
import type { ApprovalRoleContext } from "./authority";
import { compactApprovalDetailsSql, openRecipientRequests } from "./content";
import { decodeApprovalCursor, encodeApprovalCursor } from "./cursor";
import { soleCodeAdmin } from "./policy";

export type PendingApprovalRow = {
  id: string;
  kind: ApprovalKind;
  canApprove: boolean;
  /** Advisory self-approval eligibility; the decision rechecks the population under locks. */
  soleAdmin: boolean;
  requesterHref: string | null;
  appId: string;
  action: string;
  argsDigest: string;
  requesterAppId: string;
  /** The chat title when Cloud asked; unlike `conversationTitle`, a later rename does not change it. */
  requesterTitle: string | null;
  assurance: ApprovalAssurance;
  sentence: string;
  details: unknown;
  storedReview: AiStoredActionReview | null;
  createdAt: Date;
  expiresAt: Date;
  cursorCreatedAt: string;
  conversationShortId: string | null;
  conversationTitle: string | null;
  allowChat: boolean | null;
  allowAlways: boolean;
  rememberToolName: string | null;
  toolName: string;
  runConfig: AiTurnRunConfig | null;
};

const matches = (appId?: string, link?: string) => sql`
  (${appId ?? null}::text IS NULL OR r.app_id=${appId ?? null} OR r.requester_app_id=${appId ?? null})
  AND (${link ?? null}::text IS NULL OR COALESCE(r.details->'links' @> jsonb_build_array(jsonb_build_object('href', ${link ?? null}::text)),false))`;

/** List personal chat waits and independent Code-version requests addressed to the current Cloud-admin role. */
export const listPending = async (input: {
  approverUserId: string;
  roleContext?: ApprovalRoleContext;
  id?: string;
  appId?: string;
  link?: string;
  cursor?: string;
  limit?: number;
}): Promise<{ items: PendingApprovalRow[]; nextCursor: string | null; count: number; elsewhere: number }> =>
  sql.begin(async (tx) => {
    const limit = input.limit ?? APPROVALS_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1 || limit > APPROVALS_PAGE_SIZE) throw new RangeError("Invalid approval page size.");
    const cursor = input.cursor ? decodeApprovalCursor(input.cursor) : null;
    if (input.cursor && !cursor) throw new RangeError("Invalid approval cursor.");
    const open = await openRecipientRequests(input.approverUserId, input.id, input.roleContext, tx);
    const soleAdmin = open.admin && (await soleCodeAdmin(tx)) === input.approverUserId;
    const [counts] = await tx<{ count: number; elsewhere: number }[]>`WITH open AS (${open.query})
    SELECT count(*) FILTER (WHERE ${matches(input.appId, input.link)})::int AS count,
      count(*) FILTER (WHERE NOT (${matches(input.appId, input.link)}))::int AS elsewhere FROM open r`;
    const rows = await tx<PendingApprovalRow[]>`WITH open AS (${open.query})
    SELECT r.id, r.kind, (r.kind <> 'code_version' OR r.author_user_id IS DISTINCT FROM ${input.approverUserId}::uuid OR ${soleAdmin}) AS "canApprove",
      (r.kind='code_version' AND r.author_user_id IS NOT DISTINCT FROM ${input.approverUserId}::uuid AND ${soleAdmin}) AS "soleAdmin", r.requester_href AS "requesterHref", r.app_id AS "appId", r.action, r.requester_app_id AS "requesterAppId", r.requester_title AS "requesterTitle", r.assurance, r.sentence, ${compactApprovalDetailsSql()} AS details, r.args_digest AS "argsDigest",
      r.created_at AS "createdAt", r.expires_at AS "expiresAt",
      to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorCreatedAt",
      question.short_id AS "conversationShortId", question.title AS "conversationTitle",
      question.allow_chat AS "allowChat", COALESCE(question.allow_always,false) AS "allowAlways",
      question.remember_tool_name AS "rememberToolName", COALESCE(question.tool_name,r.action) AS "toolName", question.run_config AS "runConfig",
      question.stored_review AS "storedReview"
    FROM open r LEFT JOIN LATERAL (
      SELECT c.short_id, c.title, p.allow_chat, p.allow_always, p.remember_tool_name, p.tool_name, t.run_config,
        (SELECT (m.meta->'toolReviews'->review.call_id) - 'content' - 'contentRef' FROM (
          SELECT meta, conversation_id, loop_id, role, seq FROM ai.messages
          UNION ALL
          SELECT meta, conversation_id, loop_id, role, seq FROM ai.task_messages
        ) m WHERE m.conversation_id=p.conversation_id AND m.loop_id=p.turn_id::text AND m.role='assistant'
          AND m.meta->'toolReviews'->review.call_id IS NOT NULL
        ORDER BY m.seq DESC LIMIT 1) AS stored_review
      FROM ai.pending_actions p JOIN ai.conversations c ON c.id=p.conversation_id JOIN ai.turns t ON t.id=p.turn_id
        -- A capability's own approval waits as "<call>-approval-<n>"; its review is stored under the call itself.
        CROSS JOIN LATERAL (SELECT CASE WHEN p.kind = 'custom_approval'
          THEN COALESCE(substring(p.call_id FROM '^(.*)-approval-[0-9]+$'), p.call_id) ELSE p.call_id END AS call_id) review
      WHERE p.approval_id=r.id AND p.status='pending' ORDER BY p.created_at DESC, p.id DESC LIMIT 1
    ) question ON true
    WHERE ${matches(input.appId, input.link)}
      AND (${cursor?.id ?? null}::uuid IS NULL OR (r.created_at,r.id) < (${cursor?.createdAt ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
    ORDER BY r.created_at DESC,r.id DESC LIMIT ${limit + 1}`;
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > limit && last ? encodeApprovalCursor({ createdAt: last.cursorCreatedAt, id: last.id }) : null,
      count: counts?.count ?? 0,
      elsewhere: counts?.elsewhere ?? 0,
    };
  });

/** Count the same current personal and role requests as `listPending`, including requests without a chat. */
export const countPending = async (input: {
  approverUserId: string;
  roleContext?: ApprovalRoleContext;
  /** Count only one kind, such as Code versions for Administration › Code. */
  kind?: ApprovalKind;
}): Promise<ApprovalCounts> =>
  sql.begin(async (tx) => {
    const open = await openRecipientRequests(input.approverUserId, undefined, input.roleContext, tx);
    const [row] = await tx<ApprovalCounts[]>`WITH open AS MATERIALIZED (SELECT * FROM (${open.query}) all_open
      WHERE ${input.kind ?? null}::text IS NULL OR all_open.kind=${input.kind ?? null}),
    app_requests AS (SELECT DISTINCT r.id AS request_id, app.id AS app_id FROM open r
      CROSS JOIN LATERAL unnest(ARRAY[r.app_id,r.requester_app_id]) app(id)),
    app_counts AS (SELECT app_id AS id,count(*)::int AS count FROM app_requests GROUP BY app_id)
    SELECT (SELECT count(*)::int FROM open) AS total,
      COALESCE((SELECT jsonb_object_agg(id,count) FROM app_counts),'{}'::jsonb) AS apps`;
    return row ?? { total: 0, apps: {} };
  });

export const presentPendingApproval = (
  row: PendingApprovalRow,
  apps: readonly Pick<RuntimeAppMeta, "id" | "name" | "icon">[],
  policy?: CapabilityActionPolicy,
  locale = DEFAULT_LOCALE,
): PendingApproval => {
  const app = apps.find((entry) => entry.id === row.appId);
  const review = CapabilityActionReviewPresentationSchema.nullable().safeParse(row.details);
  const originalReview = review.success ? review.data : null;
  const displayReview =
    originalReview && "sentence" in originalReview
      ? row.storedReview && "sentence" in row.storedReview
        ? { ...originalReview, ask: originalReview.ask ?? row.storedReview.ask }
        : storedActionReview(originalReview, policy)
      : originalReview;
  const codeVersion = row.kind === "code_version";
  const remember = !codeVersion && row.assurance === "standard" && aiTurnAllowsRememberedApprovals(row.runConfig);
  return {
    id: row.id,
    ...(codeVersion ? { canApprove: row.canApprove } : {}),
    ...(codeVersion && row.soleAdmin ? { soleAdminNotice: approvalMessages.resolve([locale]).t.soleAdminNotice } : {}),
    app: { id: row.appId, name: app?.name ?? row.appId, icon: app?.icon ?? null },
    action: row.action,
    assurance: row.assurance,
    sentence: row.sentence,
    review: displayReview && "legacy" in displayReview ? originalReview : displayReview,
    requester: codeVersion
      ? {
          kind: "code_version",
          appId: row.requesterAppId,
          title: row.requesterTitle,
          href: row.requesterHref ?? "/me/approvals",
        }
      : {
          kind: "chat",
          appId: row.requesterAppId,
          title: row.conversationTitle,
          href: `/app/assistant?conversation=${encodeURIComponent(row.conversationShortId ?? "")}`,
        },
    remember: {
      chat: remember && (row.allowChat ?? row.allowAlways),
      always: remember && row.allowAlways,
      website: !codeVersion && (row.rememberToolName ?? row.toolName) === AI_WEBSITE_APPROVAL_TOOL,
    },
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
};
