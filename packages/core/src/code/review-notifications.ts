import { sql } from "@k2b/cloud";
import { listResourceManagers } from "@k2b/cloud/capabilities/server";
import { getEffectivePermission, listAccessRecipientUserIds } from "@k2b/cloud/server";
import { accounts, coreSettings, isAccountAllowed } from "@k2b/cloud/services";
import { listApprovalAdminRecipients } from "@k2b/cloud/services/approvals";
import { createPgOutbox, type OutboxRow } from "@k2b/cloud/services/outbox";
import type { CoreNotificationSender } from "../notifications";
import type { Code } from "./contracts";
import { type CodeReviewDecision, CodeSubmissionOriginSchema, codeVersionChatAnchor } from "./review-contracts";
import { findCode } from "./store";
import { listCodeWaiting } from "./waiting";

type NoticeRow = OutboxRow & { version_id: string; kind: "submitted" | "decided"; recipient_id: string | null; recipient_cursor: string };
/** Same page bound as the accounts directory. Each actual recipient gets a separate retryable effect. */
const RECIPIENT_PAGE = 50;

/** Expand one bounded page after commit, or deliver one person's notice after checking their current rights. */
export async function deliverCodeReviewNotice(row: NoticeRow, sender: Pick<CoreNotificationSender, "sendCodeReview">) {
  const signal = AbortSignal.timeout(25_000); // Finish before the outbox's 30-second claim ends.
  if (!row.recipient_id) {
    const [submission] = await sql<{ code_id: string; created_by: string | null }[]>`SELECT s.code_id,v.created_by
      FROM code.version_submissions s JOIN code.versions v ON v.id=s.version_id WHERE s.version_id=${row.version_id}::uuid`;
    const code = submission && (await findCode(submission.code_id));
    if (!code || code.state === "deleting") return;
    const ids =
      row.kind === "submitted"
        ? await listApprovalAdminRecipients(sql, { after: row.recipient_cursor, limit: RECIPIENT_PAGE })
        : await decisionRecipients(code, row.recipient_cursor, signal, submission?.created_by);
    await sql.begin(async (tx) => {
      for (const id of ids)
        await tx`INSERT INTO code.review_notification_outbox(version_id,kind,recipient_id)
        VALUES(${row.version_id}::uuid,${row.kind},${id}::uuid) ON CONFLICT DO NOTHING`;
      if (ids.length === RECIPIENT_PAGE)
        await tx`INSERT INTO code.review_notification_outbox(version_id,kind,recipient_cursor)
        VALUES(${row.version_id}::uuid,${row.kind},${ids.at(-1)!}::uuid) ON CONFLICT DO NOTHING`;
    });
    return;
  }
  const [version] = await sql<
    {
      code_id: string;
      number: number;
      created_by: string | null;
      locale: string;
      origin: unknown;
      outcome: CodeReviewDecision["outcome"] | null;
      name: string | null;
      pending: boolean | null;
      revision_state: string | null;
      chat_id: string | null;
    }[]
  >`SELECT s.code_id,v.number,v.created_by,s.locale,s.origin,d.outcome,(r.status='pending' AND r.expires_at>now()) AS pending,COALESCE(NULLIF(u.display_name,''),u.uid) AS name,
      w.state AS revision_state,(SELECT short_id FROM ai.conversations chat WHERE chat.id=(s.origin->>'conversationId')::uuid AND chat.created_by_user_id=v.created_by) AS chat_id
    FROM code.version_submissions s JOIN code.versions v ON v.id=s.version_id
    LEFT JOIN approvals.requests r ON r.id=s.approval_id
    LEFT JOIN code.version_decisions d ON d.version_id=v.id LEFT JOIN auth.users u ON u.id=d.decided_by
    LEFT JOIN code.review_chat_work w ON w.version_id=v.id
    WHERE s.version_id=${row.version_id}::uuid`;
  if (!version) return;
  const code = await findCode(version.code_id);
  if (!code || code.state === "deleting") return;
  const user = await accounts.users.get({ id: row.recipient_id });
  if (!user || (user.accountExpires && Date.parse(user.accountExpires) <= Date.now()) || !(await isAccountAllowed(user))) return;
  if (row.kind === "submitted") {
    if (!version.pending) return;
    if (!(await listApprovalAdminRecipients(sql, { userId: user.id })).length) return;
  } else {
    if (!version.outcome) throw new Error("Decision notice has no durable decision");
    // Recheck current domain grants as data, using the application's workload identity for an external owner.
    if (!(await isDecisionRecipient(code, user.id, signal))) return;
  }
  const [preference] = await sql<
    { locale: string | null }[]
  >`SELECT notification_locale AS locale FROM auth.users WHERE id=${user.id}::uuid`;
  const locale = preference?.locale ?? (user.id === version.created_by ? version.locale : await coreSettings.get<string>("app.locale"));
  const origin = CodeSubmissionOriginSchema.parse(version.origin);
  const ownChat = row.kind === "decided" && user.id === version.created_by && origin.kind === "ai_chat" && version.chat_id;
  const targetHref: `/${string}` | undefined =
    ownChat && origin.kind === "ai_chat"
      ? `/app/assistant?conversation=${encodeURIComponent(version.chat_id!)}&question=${encodeURIComponent(codeVersionChatAnchor(row.version_id, origin))}`
      : undefined;
  const waiting = ownChat
    ? (await listCodeWaiting({ ownerUserId: user.id, locale, timeZone: "UTC", versionId: row.version_id }, signal)).items[0]
    : undefined;
  await sender.sendCodeReview({
    userId: user.id,
    codeId: code.id,
    title: code.title,
    versionId: row.version_id,
    number: version.number,
    kind: row.kind,
    outcome: version.outcome,
    by: version.name,
    locale,
    origin,
    targetHref,
    waiting: waiting ? { short: waiting.short, href: targetHref! } : undefined,
    automaticRevision: version.revision_state === "queued" || version.revision_state === "running",
    key: `code-review:${row.version_id}:${row.kind}:${user.id}`,
  });
}

export const createCodeReviewNotificationOutbox = (sender: Pick<CoreNotificationSender, "sendCodeReview">) =>
  createPgOutbox<NoticeRow>({
    table: "code.review_notification_outbox",
    name: "core:code-review-notifications",
    orderBy: "version_id",
    sequence: "sequence",
    batchSize: 1,
    reconcileIntervalMs: 5000,
    publish: (row) => deliverCodeReviewNotice(row, sender),
  });

async function recipientGrants(code: Code) {
  const shares = await sql<{ access_id: string }[]>`SELECT access_id FROM code.shares WHERE code_id=${code.id}`;
  const app =
    code.owner.kind === "app"
      ? await sql<{ access_id: string }[]>`SELECT access_id FROM auth.app_access WHERE app_id=${code.owner.appId}`
      : [];
  return { shares: shares.map((row) => row.access_id), app: app.map((row) => row.access_id) };
}
async function decisionRecipients(code: Code, afterId: string, signal: AbortSignal, submittedBy?: string | null) {
  const grants = await recipientGrants(code);
  const [shared, app, owner] = await Promise.all([
    listAccessRecipientUserIds({ accessIds: grants.shares, minimumPermission: "write", afterId, limit: RECIPIENT_PAGE }),
    listAccessRecipientUserIds({ accessIds: grants.app, afterId, limit: RECIPIENT_PAGE }),
    code.owner.kind === "resource"
      ? listResourceManagers({ ref: code.owner.ref, afterId, limit: RECIPIENT_PAGE, signal })
      : Promise.resolve(code.owner.kind === "person" ? [code.owner.userId] : []),
  ]);
  return [...new Set([...shared, ...app, ...owner, ...(submittedBy ? [submittedBy] : [])])]
    .filter((id) => id > afterId)
    .sort()
    .slice(0, RECIPIENT_PAGE);
}
async function isDecisionRecipient(code: Code, userId: string, signal: AbortSignal) {
  if (code.owner.kind === "person" && code.owner.userId === userId) return true;
  const grants = await recipientGrants(code),
    subject = { type: "user" as const, userId };
  if (["write", "admin"].includes(await getEffectivePermission({ accessIds: grants.shares, subject }))) return true;
  if (code.owner.kind === "app") return (await getEffectivePermission({ accessIds: grants.app, subject })) === "admin";
  return code.owner.kind === "resource" && (await listResourceManagers({ ref: code.owner.ref, userId, limit: 1, signal })).includes(userId);
}
