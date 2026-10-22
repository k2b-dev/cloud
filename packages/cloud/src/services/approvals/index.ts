import { type SQL, sql } from "bun";
import { capabilityRequestHash } from "../../capabilities/claims";
import { restoreReviewSnapshot, serializeReviewSnapshot } from "../../capabilities/review-storage";
import { APPROVAL_ACP_CLIENT } from "../../contracts/approvals";
import type { CapabilityActionReviewData } from "../../contracts/capabilities";
import { CapabilityActionReviewPresentationSchema } from "../../contracts/capabilities";
import { isAppSessionActor } from "../../server/actor";
import type { RequestActor, RequestCredentialKind } from "../../server/middleware/auth";
import { audit } from "../audit";
import { toPgTextArray } from "../postgres";
import { compactApprovalDetailsSql } from "./content";

export { countPending, listPending, presentPendingApproval } from "./list";
export { migrateApprovals } from "./migrate";
export { type ApprovalActionPolicy, loadApprovalActionPolicies, pendingApprovalCard } from "./question";

// Derived from chat's AI_ACTION_BUDGET_MS and Studio's one-day abandonment of pending calls.
export const APPROVAL_MAX_WAIT_MS = 24 * 60 * 60_000;
export type ApprovalDecisionChannel = "web_session" | "app_session" | "oauth" | "api_key" | "invocation" | "acp_bridge" | "cloud_login";
export type ApprovalRequesterKind = "assistant_turn" | "studio_app";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "cancelled" | "consumed";
export type ApprovalAssurance = "standard" | "confirm";

/**
 * `standard` when the person may remember the approval of this call: an Action with `approval: "rememberable"` whose
 * review names a scope for these arguments, a tool whose policy allows remembering, or a website. Otherwise `confirm`.
 */
export const approvalAssurance = (rememberable: boolean): ApprovalAssurance => (rememberable ? "standard" : "confirm");
export const approvalArgsDigest = (input: unknown): string => capabilityRequestHash(input);
export const approvalReviewDigest = (review: CapabilityActionReviewData | null | undefined): string =>
  capabilityRequestHash(review ?? null);
export const approvalDecisionChannel = (input: {
  credentialKind?: RequestCredentialKind;
  actor?: RequestActor;
  client?: string | null;
}): ApprovalDecisionChannel =>
  input.client === APPROVAL_ACP_CLIENT
    ? "acp_bridge"
    : input.credentialKind === "session"
      ? isAppSessionActor(input.actor)
        ? "app_session"
        : "web_session"
      : (input.credentialKind ?? "invocation");
export const approvalScopeFromToolName = (name: string): { appId: string; action: string } => {
  const dot = name.indexOf(".");
  return dot < 0 ? { appId: "assistant", action: name } : { appId: name.slice(0, dot), action: name.slice(dot + 1) };
};

export type ApprovalRequestInput = {
  appId: string;
  action: string;
  approvalScope?: string | null;
  requester: { kind: ApprovalRequesterKind; ref: string; appId: string; title?: string | null };
  subjectId: string;
  approverUserId: string;
  assurance: ApprovalAssurance;
  sentence: string;
  review?: CapabilityActionReviewData | null;
  input: unknown;
  expiresInMs: number;
};
export type ApprovalRequest = {
  id: string;
  appId: string;
  action: string;
  approvalScope: string | null;
  requesterKind: ApprovalRequesterKind;
  requesterRef: string;
  requesterAppId: string;
  requesterTitle: string | null;
  subjectId: string;
  approverUserId: string;
  assurance: ApprovalAssurance;
  sentence: string;
  details: CapabilityActionReviewData | null;
  argsDigest: string;
  reviewDigest: string;
  status: ApprovalStatus;
  decidedVia: ApprovalDecisionChannel | null;
  decidedDeviceId: string | null;
  approverAuthEpoch: string | null;
  decidedAt: Date | null;
  consumedAt: Date | null;
  createdAt: Date;
  expiresAt: Date;
};
// SQL aliases keep the public row shape identical for reads and locked transaction reads. A function, because a
// fragment built at import time would bind the default sql handle before a test can choose its database.
const columns = (compact = false) => sql`id, app_id AS "appId", action, approval_scope AS "approvalScope",
  requester_kind AS "requesterKind", requester_ref AS "requesterRef", requester_app_id AS "requesterAppId",
  requester_title AS "requesterTitle", subject_id AS "subjectId", approver_user_id AS "approverUserId",
  assurance, sentence, ${compact ? compactApprovalDetailsSql("approvals.requests") : sql`details`} AS details, args_digest AS "argsDigest", review_digest AS "reviewDigest", status,
  decided_device_id AS "decidedDeviceId", approver_auth_epoch::text AS "approverAuthEpoch",
  decided_via AS "decidedVia", decided_at AS "decidedAt", consumed_at AS "consumedAt",
  created_at AS "createdAt", expires_at AS "expiresAt"`;

const transaction = <T>(db: SQL | undefined, run: (tx: SQL) => Promise<T>): Promise<T> => (db && db !== sql ? run(db) : sql.begin(run));

const lockDecider = async (tx: SQL, userId: string, deviceId: string | null) => {
  // User before device before request: sign-out everywhere updates the user first, then devices.
  const [user] = await tx<{ epoch: string }[]>`SELECT auth_epoch::text AS epoch FROM auth.users WHERE id=${userId}::uuid FOR SHARE`;
  const [device] =
    deviceId === null
      ? []
      : await tx`SELECT 1 FROM auth.app_devices
    WHERE id=${deviceId}::uuid AND user_id=${userId}::uuid AND revoked_at IS NULL FOR SHARE`;
  return { epoch: user?.epoch ?? null, deviceActive: !!device };
};

export type ApprovalRequestResult = { ok: true; id: string } | { ok: false; code: "CONFLICT" };
/**
 * Records the question once per requester reference. Asking again, for example after a worker restart, returns the
 * open request unchanged: its snapshot is what the person may already see, so a changed effect fails `consume` and
 * asks again instead of rebinding that decision. A reference whose request is decided, expired, or another person's
 * is a conflict.
 */
export const request = async (input: ApprovalRequestInput, db?: SQL): Promise<ApprovalRequestResult> => {
  // Zero or less records a request that is already expired, such as a call that waited too long before the upgrade.
  const expiresInMs = Number.isNaN(input.expiresInMs)
    ? APPROVAL_MAX_WAIT_MS
    : Math.max(0, Math.min(input.expiresInMs, APPROVAL_MAX_WAIT_MS));
  return transaction(db, async (tx): Promise<ApprovalRequestResult> => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO approvals.requests (app_id, action, approval_scope, requester_kind, requester_ref, requester_app_id,
        requester_title, subject_id, approver_user_id, approver_auth_epoch, assurance, sentence, details, args_digest, review_digest, expires_at)
      VALUES (${input.appId}, ${input.action}, ${input.approvalScope ?? null}, ${input.requester.kind}, ${input.requester.ref},
        ${input.requester.appId}, ${input.requester.title ?? null}, ${input.subjectId}::uuid, ${input.approverUserId}::uuid,
        (SELECT auth_epoch FROM auth.users WHERE id=${input.approverUserId}::uuid), ${input.assurance}, ${input.sentence}, ${serializeReviewSnapshot(input.review ?? null)}::text::jsonb,
        ${approvalArgsDigest(input.input)}, ${approvalReviewDigest(input.review)}, now() + (${expiresInMs} * interval '1 millisecond'))
      ON CONFLICT (requester_kind, requester_ref) DO NOTHING
      RETURNING id
    `;
    if (row) return { ok: true, id: row.id };
    const [open] = await tx<{ id: string }[]>`SELECT id FROM approvals.requests
      WHERE requester_kind=${input.requester.kind} AND requester_ref=${input.requester.ref}
        AND status='pending' AND expires_at > now() AND subject_id=${input.subjectId}::uuid
        AND approver_auth_epoch=(SELECT auth_epoch FROM auth.users WHERE id=${input.approverUserId}::uuid)
        AND approver_user_id=${input.approverUserId}::uuid AND app_id=${input.appId} AND action=${input.action}`;
    return open ? { ok: true, id: open.id } : { ok: false, code: "CONFLICT" };
  });
};

export const get = async (id: string, db?: SQL, compactReview = false): Promise<ApprovalRequest | null> =>
  transaction(db, async (tx) => {
    const [row] = await tx<ApprovalRequest[]>`SELECT ${columns(compactReview)} FROM approvals.requests WHERE id=${id}::uuid`;
    return row
      ? {
          ...row,
          details: row.details === null ? null : CapabilityActionReviewPresentationSchema.parse(restoreReviewSnapshot(row.details)),
        }
      : null;
  });

export type ApprovalDecisionResult =
  | { ok: true; status: ApprovalStatus; replay: boolean }
  | { ok: false; code: "EXPIRED" | "NOT_FOUND" | "REJECT_ONLY" }
  | { ok: false; code: "ALREADY_DECIDED"; status: ApprovalStatus };
export const decide = async (
  id: string,
  decision: { approved: boolean },
  actor: { userId: string; via: ApprovalDecisionChannel; deviceId?: string },
  db?: SQL,
): Promise<ApprovalDecisionResult> => {
  const result = await transaction(db, async (tx): Promise<ApprovalDecisionResult> => {
    // Lock the approver and device before the request so revocation and decisions serialize.
    const decider = await lockDecider(tx, actor.userId, actor.deviceId ?? null);
    if (actor.deviceId !== undefined && !decider.deviceActive) return { ok: false, code: "NOT_FOUND" };
    const [row] = await tx<ApprovalRequest[]>`SELECT ${columns()} FROM approvals.requests
      WHERE id=${id}::uuid AND approver_user_id=${actor.userId}::uuid FOR UPDATE`;
    if (!row) return { ok: false, code: "NOT_FOUND" };
    const rejectOnly = decision.approved && row.assurance === "confirm" && actor.via === "acp_bridge";
    const status = decision.approved ? "approved" : "rejected";
    const [won] = rejectOnly
      ? []
      : await tx<ApprovalRequest[]>`
      UPDATE approvals.requests SET status=${status}, decided_via=${actor.via}, decided_device_id=${actor.deviceId ?? null}::uuid, decided_at=now()
      WHERE id=${id}::uuid AND approver_user_id=${actor.userId}::uuid AND status='pending' AND expires_at > now()
        AND approver_auth_epoch=${decider.epoch}::bigint
      RETURNING ${columns()}
    `;
    if (won) {
      await audit.record(
        {
          action: decision.approved ? "auth.action.approve" : "auth.action.deny",
          outcome: "allowed",
          actor: { userId: actor.userId },
          target: { type: "approval_request", id, label: `${won.appId}.${won.action}` },
          metadata: {
            appId: won.appId,
            action: won.action,
            assurance: won.assurance,
            decidedVia: actor.via,
            ...(actor.deviceId !== undefined ? { deviceId: actor.deviceId } : {}),
            requesterKind: won.requesterKind,
            requesterAppId: won.requesterAppId,
          },
        },
        tx,
      );
      return { ok: true, status, replay: false };
    }
    if (row.status === "pending") {
      const [expired] = await tx<{ id: string }[]>`UPDATE approvals.requests SET status='expired'
        WHERE id=${id}::uuid AND status='pending'
          AND (expires_at <= now() OR approver_auth_epoch IS DISTINCT FROM ${decider.epoch}::bigint) RETURNING id`;
      return { ok: false, code: expired || !rejectOnly ? "EXPIRED" : "REJECT_ONLY" };
    }
    if (
      (decision.approved && (row.status === "approved" || row.status === "consumed")) ||
      (!decision.approved && row.status === "rejected")
    )
      return { ok: true, status: row.status, replay: true };
    return { ok: false, code: "ALREADY_DECIDED", status: row.status };
  });
  // Publish a later NATS decision hint only after the owning transaction commits.
  return result;
};

export type ApprovalConsumeResult =
  | { ok: true }
  | { ok: false; code: "NOT_FOUND" | "NOT_APPROVED" | "ALREADY_CONSUMED" | "INPUT_CHANGED" | "REVIEW_CHANGED" | "REVOKED" };
export const consume = async (
  id: string,
  input: { input: unknown; review: CapabilityActionReviewData | null; requester: { kind: ApprovalRequesterKind; ref: string } },
  db?: SQL,
): Promise<ApprovalConsumeResult> => {
  const argsDigest = approvalArgsDigest(input.input),
    reviewDigest = approvalReviewDigest(input.review);
  return transaction(db, async (tx): Promise<ApprovalConsumeResult> => {
    const [initial] = await tx<ApprovalRequest[]>`SELECT ${columns()} FROM approvals.requests
      WHERE id=${id}::uuid AND requester_kind=${input.requester.kind} AND requester_ref=${input.requester.ref}`;
    if (!initial) return { ok: false, code: "NOT_FOUND" };
    if (initial.status === "consumed") return { ok: false, code: "ALREADY_CONSUMED" };
    if (initial.status !== "approved") return { ok: false, code: "NOT_APPROVED" };
    const decider = await lockDecider(tx, initial.approverUserId, initial.decidedDeviceId);
    const [row] = await tx<ApprovalRequest[]>`SELECT ${columns()} FROM approvals.requests
      WHERE id=${id}::uuid AND requester_kind=${input.requester.kind} AND requester_ref=${input.requester.ref} FOR UPDATE`;
    if (!row) return { ok: false, code: "NOT_FOUND" };
    if (row.status === "consumed") return { ok: false, code: "ALREADY_CONSUMED" };
    if (row.status !== "approved") return { ok: false, code: "NOT_APPROVED" };
    if (
      (row.decidedVia === "cloud_login" && row.decidedDeviceId === null) ||
      (row.decidedDeviceId !== null && !decider.deviceActive) ||
      row.approverAuthEpoch === null ||
      row.approverAuthEpoch !== decider.epoch
    ) {
      await tx`UPDATE approvals.requests SET status='cancelled' WHERE id=${id}::uuid AND status='approved'`;
      return { ok: false, code: "REVOKED" };
    }
    if (row.argsDigest !== argsDigest || row.reviewDigest !== reviewDigest) {
      await tx`UPDATE approvals.requests SET status='cancelled' WHERE id=${id}::uuid AND status='approved'`;
      return { ok: false, code: row.argsDigest !== argsDigest ? "INPUT_CHANGED" : "REVIEW_CHANGED" };
    }
    await tx`UPDATE approvals.requests SET status='consumed', consumed_at=now() WHERE id=${id}::uuid AND status='approved'
      AND requester_kind=${input.requester.kind} AND requester_ref=${input.requester.ref}
      AND args_digest=${argsDigest} AND review_digest=${reviewDigest}`;
    return { ok: true };
  });
};

export const cancel = async (ids: string[], db?: SQL): Promise<void> => {
  if (!ids.length) return;
  await transaction(db, async (tx) => {
    await tx`UPDATE approvals.requests SET status='cancelled' WHERE id=ANY(${toPgTextArray(ids)}::uuid[]) AND status IN ('pending','approved')`;
  });
};

export const pruneApprovalRequests = async (before: Date): Promise<number> => {
  let total = 0;
  let deleted: number;
  do {
    const result = await sql`WITH expired AS (SELECT id FROM approvals.requests WHERE expires_at < ${before} LIMIT 5000)
      DELETE FROM approvals.requests request USING expired WHERE request.id=expired.id`;
    deleted = result.count;
    total += deleted;
  } while (deleted === 5000);
  return total;
};

export const approvals = { request, get, decide, consume, cancel };
