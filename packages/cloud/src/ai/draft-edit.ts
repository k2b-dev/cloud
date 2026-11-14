import { z } from "zod";
import { capabilitySentenceText } from "../_internal/capability-sentences";
import { getCapability } from "../_internal/registry";
import { capabilityCallFromTool, capabilityInvocationBody } from "../capabilities/calls";
import { restoreReviewSnapshot, serializeReviewSnapshot } from "../capabilities/review-storage";
import { boundReviewView, reviewDraft } from "../capabilities/reviews";
import { reviewCapabilityAction } from "../capabilities/server";
import {
  CAPABILITY_MAX_REQUEST_BYTES,
  type CapabilityActionCallReview,
  CapabilityActionCallReviewSchema,
  type CapabilityActionReviewPresentation,
  NormalizedCapabilityCallSchema,
} from "../contracts/capabilities";
import { sql } from "../runtime/clients";
import type { RequestAuthority } from "../server/middleware/auth";
import { approvalArgsDigest, approvalReviewDigest } from "../services/approvals";
import { compactCapabilityReview, storedReviewWithContent } from "./review-content";
import type { AiTurnRunConfig } from "./types";

export class DraftEditError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

/** The stored raw writer review is the authority. Converted presentations never enter this path. */
export function draftEditValues(raw: unknown, values: Record<string, string>): { review: CapabilityActionCallReview; fields: string[] } {
  const restored = restoreReviewSnapshot(raw);
  const writer =
    restored && typeof restored === "object" && "editedFields" in restored
      ? Object.fromEntries(Object.entries(restored).filter(([key]) => key !== "editedFields"))
      : restored;
  const parsed = CapabilityActionCallReviewSchema.safeParse(writer);
  const draft = parsed.success ? reviewDraft(boundReviewView(parsed.data)?.blocks) : undefined;
  if (!parsed.success || !draft) throw new DraftEditError(409, "This approval has no editable draft.");
  const names = new Set(draft.fields.map((field) => field.name));
  if (!Object.keys(values).length || Object.entries(values).some(([name, value]) => !names.has(name) || typeof value !== "string"))
    throw new DraftEditError(400, "Only the draft's declared string fields may be edited.");
  for (const field of draft.fields) {
    const value = values[field.name];
    if (value === undefined) continue;
    if (
      new TextEncoder().encode(value).byteLength > CAPABILITY_MAX_REQUEST_BYTES ||
      (field.required && !value.trim()) ||
      (field.type === "select" && !field.options?.some((option) => option.value === value))
    )
      throw new DraftEditError(400, `Invalid value for ${field.name}.`);
  }
  return { review: parsed.data, fields: [...names] };
}

/** One browser-only runtime operation, locking the request and pending call for the entire CAS. */
export async function editAiApprovalDraft(input: {
  id: string;
  values: Record<string, string>;
  digest: string;
  authority: RequestAuthority;
  signedInSession: boolean;
  signal?: AbortSignal;
}) {
  const actor = input.authority.actor;
  if (
    !input.signedInSession ||
    input.authority.credentialKind !== "session" ||
    actor.kind !== "user" ||
    actor.delegation ||
    input.authority.accessSubject.type !== "user" ||
    input.authority.accessSubject.userId !== actor.user.id
  )
    throw new DraftEditError(403, "Draft editing requires the approval owner's own browser session.");
  return sql.begin(async (tx) => {
    input.signal?.throwIfAborted();
    // Same user-before-request lock order as decisions and sign-out everywhere.
    const [user] = await tx<
      { epoch: string }[]
    >`SELECT auth_epoch::text AS epoch FROM auth.users WHERE id=${actor.user.id}::uuid FOR SHARE`;
    const [row] = await tx<
      {
        id: string;
        app_id: string;
        action: string;
        details: unknown;
        review_digest: string;
        pending_review: unknown;
        args: unknown;
        call_id: string;
        turn_id: string;
        conversation_id: string;
        run_config: AiTurnRunConfig;
      }[]
    >`
      SELECT r.id,r.app_id,r.action,r.details,r.review_digest,p.review AS pending_review,p.args,p.call_id,p.turn_id,p.conversation_id,t.run_config
      FROM approvals.requests r JOIN ai.pending_actions p ON p.approval_id=r.id
      JOIN ai.turns t ON t.id=p.turn_id JOIN ai.conversations c ON c.id=p.conversation_id
      WHERE r.id=${input.id}::uuid AND r.kind='action' AND r.requester_kind='assistant_turn'
        AND r.approver_user_id=${actor.user.id}::uuid AND r.subject_id=${actor.user.id}::uuid
        AND r.approver_auth_epoch=${user?.epoch ?? null}::bigint
        AND c.created_by_user_id=${actor.user.id}::uuid AND c.archived_at IS NULL
        AND r.status='pending' AND r.expires_at>now() AND p.status='pending'
        AND t.status='waiting_for_action' AND t.cancel_requested_at IS NULL
        AND p.tool_name=r.app_id || '.' || r.action
      FOR UPDATE OF r,p,t`;
    if (!row) throw new DraftEditError(404, "Open editable approval not found.");
    if (row.review_digest !== input.digest) throw new DraftEditError(409, "This draft changed. Reload the approval.");
    const config = row.run_config;
    if (
      config.kind === "compact" ||
      config.background ||
      config.mandate ||
      config.codeOrigin ||
      config.actor?.kind !== "user" ||
      config.actor.delegation ||
      config.actor.user.id !== actor.user.id
    )
      throw new DraftEditError(403, "This request is not a personal chat action.");
    const checked = draftEditValues(row.details, input.values);
    const capability = await getCapability(row.app_id);
    const action = capability?.manifest.actions.find((action) => action.localId === row.action);
    if (!action) throw new DraftEditError(409, "The action is unavailable. Retry after reloading.");
    const original = z.record(z.string(), z.unknown()).parse(typeof row.args === "string" ? JSON.parse(row.args) : row.args);
    const normalized = NormalizedCapabilityCallSchema.safeParse(original);
    const flat = normalized.success
      ? {
          ...z.record(z.string(), z.unknown()).parse(normalized.data.input),
          ...(action.target && normalized.data.target ? { [action.target]: normalized.data.target.id } : {}),
          ...Object.fromEntries(Object.entries(normalized.data.refs).map(([name, ref]) => [name, ref.id])),
        }
      : original;
    const args = { ...flat, ...input.values };
    if (new TextEncoder().encode(JSON.stringify(args)).byteLength > CAPABILITY_MAX_REQUEST_BYTES)
      throw new DraftEditError(400, "Edited arguments exceed the action's input budget.");
    const call = capabilityCallFromTool(row.app_id, action, args);
    const reviewed = await reviewCapabilityAction(
      { appId: row.app_id, capabilityId: row.action, ...capabilityInvocationBody(call), signal: input.signal },
      { authority: input.authority, locale: checked.review.locale, origin: "assistant" },
    );
    if (!reviewed.ok) throw new DraftEditError(reviewed.error.status === 403 ? 403 : 409, reviewed.error.message);
    if (!("sentence" in reviewed.data)) throw new DraftEditError(409, "The action no longer returns an editable draft.");
    const next = draftEditValues(reviewed.data, input.values);
    if (next.fields.length !== checked.fields.length || next.fields.some((name) => !checked.fields.includes(name)))
      throw new DraftEditError(409, "The draft's fields changed. Reload the approval.");
    const digest = approvalReviewDigest(reviewed.data);
    const argsDigest = approvalArgsDigest(action.target !== undefined || action.refs !== undefined || normalized.success ? call : args);
    const parent = row.call_id.replace(/-approval-[0-9]+$/, "");
    const location = { conversationId: row.conversation_id, turnId: row.turn_id, callId: parent };
    const stored = {
      ...storedReviewWithContent({ ...reviewed.data, draft: { editable: true, fields: next.fields } }, location),
      editedFields: [
        ...new Set([
          ...z.object({ editedFields: z.array(z.string()).default([]) }).parse(restoreReviewSnapshot(row.pending_review)).editedFields,
          ...Object.keys(input.values),
        ]),
      ],
    };
    const review = compactCapabilityReview(stored as CapabilityActionReviewPresentation, location);
    const sentence = capabilitySentenceText(reviewed.data.sentence.action, reviewed.data.slots, {
      locale: reviewed.data.locale,
      timeZone: config.timeZone ?? "UTC",
    });
    input.signal?.throwIfAborted();
    const won =
      await tx`UPDATE approvals.requests SET details=${serializeReviewSnapshot({ ...reviewed.data, editedFields: stored.editedFields })}::text::jsonb,
      args_digest=${argsDigest},review_digest=${digest},sentence=${sentence}
      WHERE id=${row.id}::uuid AND status='pending' AND review_digest=${input.digest} RETURNING id`;
    if (!won.length) throw new DraftEditError(409, "This draft changed. Reload the approval.");
    await tx`UPDATE ai.pending_actions SET args=${JSON.stringify(JSON.stringify(args))}::text::jsonb,
      review=${serializeReviewSnapshot(stored)}::text::jsonb,message=${sentence}
      WHERE approval_id=${row.id}::uuid AND status='pending'`;
    // Keep the original tool_call arguments. Only its Cloud-owned review metadata changes.
    for (const table of ["ai.messages", "ai.task_messages"])
      await tx`UPDATE ${tx(table)} SET meta=jsonb_set(COALESCE(meta,'{}'::jsonb),'{toolReviews}',COALESCE(meta->'toolReviews','{}'::jsonb) || jsonb_build_object(${parent}::text,${serializeReviewSnapshot(stored)}::text::jsonb))
        WHERE conversation_id=${row.conversation_id}::uuid AND loop_id=${row.turn_id} AND role='assistant' AND meta->'toolReviews' ? ${parent}`;
    await tx`UPDATE ai.turns SET live_blocks=(SELECT jsonb_agg(CASE WHEN block->>'kind'='tool' AND block->>'callId'=${row.call_id}
      THEN jsonb_set(jsonb_set(block,'{review}',${JSON.stringify(review)}::text::jsonb),'{approval}',COALESCE(block->'approval','{}'::jsonb) || jsonb_build_object('review',${JSON.stringify(review)}::text::jsonb,'requestId',${row.id}::text,'digest',${digest}::text)) ELSE block END)
      FROM jsonb_array_elements(live_blocks) block) WHERE id=${row.turn_id}::uuid`;
    return { review, digest };
  });
}

/** Effective args survive every replay; the assistant's original tool_call remains untouched. */
export async function editedDraftArguments(input: {
  conversationId: string;
  turnId: string;
  callId: string;
  name: string;
  args: unknown;
}): Promise<{ args: unknown; fields: string[] }> {
  const [row] = await sql<{ args: unknown; review: unknown }[]>`SELECT p.args,p.review FROM ai.pending_actions p
    WHERE p.conversation_id=${input.conversationId}::uuid AND p.turn_id=${input.turnId}::uuid
      AND regexp_replace(p.call_id,'-approval-[0-9]+$','')=${input.callId}
      AND p.tool_name=${input.name} AND p.status IN ('pending','resolved') AND p.review ? 'editedFields'
    ORDER BY p.created_at DESC,p.id DESC LIMIT 1`;
  if (!row) return { args: input.args, fields: [] };
  const raw = restoreReviewSnapshot(row.review);
  const review = z.object({ editedFields: z.array(z.string()) }).parse(raw);
  return { args: typeof row.args === "string" ? JSON.parse(row.args) : row.args, fields: review.editedFields };
}
