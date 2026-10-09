import type { AccessSubject } from "@k2b/cloud/server";
import { sql } from "bun";
import type { MutationResult } from "../contracts";
import { ClaimTaskSchema, type TaskWork, TaskWorkSchema, type WorkActor, WorkActorSchema, WorkTextSchema } from "../work-contracts";
import { buildSpacePrincipalCondition } from "./access";
import * as activity from "./activity";
import { publishSpaceChange, spacesLive } from "./live";

type Db = typeof sql;
const empty = (): TaskWork => ({ claim: null, progress: null, result: null });

export const read = async (itemId: string, db: Db = sql): Promise<TaskWork> => {
  const [row] = await db<{ claim: unknown; progress: unknown; result: unknown }[]>`
    SELECT claim, progress, result FROM spaces.task_work WHERE item_id = ${itemId}::uuid
  `;
  return row ? TaskWorkSchema.parse(row) : empty();
};

type WorkClaim = NonNullable<TaskWork["claim"]>;

/**
 * Caller holds the item row lock. The claim ID coordinates sessions sharing an actor. Claims coordinate work and do
 * not lock it: with `force`, any writer takes over the exact claim it observed, and the result names the claim taken
 * over from another account so the caller can record it. A forced change of a task nobody holds goes ahead.
 */
export const checkClaim = async (
  itemId: string,
  actor: activity.SpaceActivityIdentity,
  claimId?: string,
  db: Db = sql,
  force = false,
): Promise<MutationResult<WorkClaim | null>> => {
  const { claim } = await read(itemId, db);
  const own = claim !== null && claim.actor.kind === actor.kind && claim.actor.id === actor.id;
  if (claim && force) {
    if (claim.id !== claimId) return { ok: false, error: "Task claim changed; read its current state before taking it over", status: 409 };
    return { ok: true, data: own ? null : claim };
  }
  if (claim && (claim.id !== claimId || !own))
    return { ok: false, error: "Task is claimed; release its current claim before changing ownership or completing it", status: 409 };
  if (!claim && claimId && !force) return { ok: false, error: "Task claim is no longer active", status: 409 };
  return { ok: true, data: null };
};

/** Audits a take-over with the previous holder's name at that moment, as activity keeps item titles. */
export const recordTakeOver = async (
  params: { spaceId: string; itemId: string; itemTitle: string; actor: activity.SpaceActivityIdentity; claim: WorkClaim },
  db: Db,
) => {
  const { kind, id } = params.claim.actor;
  const [holder] = await db<{ name: string | null }[]>`
    SELECT COALESCE(NULLIF(u.display_name, ''), u.uid, sa.name) AS name
    FROM (SELECT 1) AS one
    LEFT JOIN auth.users u ON ${kind} = 'user' AND u.id = ${id}::uuid
    LEFT JOIN auth.service_accounts sa ON ${kind} = 'service_account' AND sa.id = ${id}::uuid
  `;
  await activity.record(
    {
      spaceId: params.spaceId,
      itemId: params.itemId,
      actor: params.actor,
      action: "task.taken_over",
      metadata: { itemTitle: params.itemTitle, from: params.claim.actor, fromName: holder?.name ?? null },
    },
    db,
  );
};

export const finish = async (
  itemId: string,
  result: string | undefined,
  commit: string | undefined,
  actor: activity.SpaceActivityIdentity,
  db: Db,
) => {
  if (result === undefined) {
    await db`UPDATE spaces.task_work SET claim = NULL WHERE item_id = ${itemId}::uuid`;
    return;
  }
  const note = { content: result, commit: commit ?? null, actor: WorkActorSchema.parse(actor), at: new Date().toISOString() };
  await db`
    INSERT INTO spaces.task_work (item_id, result) VALUES (${itemId}::uuid, ${note}::jsonb)
    ON CONFLICT (item_id) DO UPDATE SET claim = NULL, result = EXCLUDED.result
  `;
};

export const change = async (params: {
  itemId: string;
  spaceId: string;
  actor: WorkActor;
  subject: AccessSubject;
  force?: boolean;
  operation: "claim" | "release" | "progress";
  claimId?: string;
  content?: string;
}): Promise<MutationResult<TaskWork>> => {
  WorkActorSchema.parse(params.actor);
  if (params.operation === "progress") {
    const content = WorkTextSchema.safeParse(params.content);
    if (!content.success) return { ok: false, error: content.error.issues[0]!.message, status: 400 };
    params = { ...params, content: content.data };
  } else if (!ClaimTaskSchema.safeParse({ claimId: params.claimId }).success) {
    return { ok: false, error: "A valid claim ID is required", status: 400 };
  }
  const result = await sql.begin(async (tx): Promise<MutationResult<TaskWork>> => {
    const principal = buildSpacePrincipalCondition(params.subject);
    const [grant] = await tx<{ allowed: boolean }[]>`SELECT EXISTS (
      SELECT 1 FROM spaces.space_access sa JOIN auth.access a ON a.id = sa.access_id
      WHERE sa.space_id = ${params.spaceId}::uuid AND ${principal}
        AND a.permission IN ('write', 'admin')
    ) AS allowed`;
    if (!grant?.allowed) return { ok: false, error: "Access denied", status: 403 };
    // Same lock order as task completion/dependency edits.
    await tx`SELECT pg_advisory_xact_lock(hashtext('spaces.item-dependencies'), hashtext(${params.spaceId}))`;
    const [item] = await tx<{ title: string; completed_at: Date | null; starts_at: Date | null; ends_at: Date | null }[]>`
      SELECT title, completed_at, starts_at, ends_at FROM spaces.items
      WHERE id = ${params.itemId}::uuid AND space_id = ${params.spaceId}::uuid FOR UPDATE
    `;
    if (!item) return { ok: false, error: "Task not found", status: 404 };
    if (item.starts_at || item.ends_at) return { ok: false, error: "Work tracking is only available for tasks", status: 400 };
    const work = await read(params.itemId, tx);
    let takenOver: WorkClaim | null = null;
    if (params.operation === "claim") {
      if (!params.claimId) return { ok: false, error: "A claim ID is required", status: 400 };
      if (item.completed_at) return { ok: false, error: "Reopen the task before claiming it", status: 409 };
      const [blocked] = await tx<{ blocked: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM spaces.item_dependencies d JOIN spaces.items b ON b.id = d.blocker_item_id
          WHERE d.item_id = ${params.itemId}::uuid AND b.completed_at IS NULL) AS blocked
      `;
      if (blocked?.blocked) return { ok: false, error: "Complete all blocking tasks first", status: 409 };
      if (work.claim) {
        const check = await checkClaim(params.itemId, params.actor, params.claimId, tx);
        return check.ok ? { ok: true, data: work } : check;
      }
      work.claim = { id: params.claimId, actor: params.actor, claimedAt: new Date().toISOString() };
    } else {
      if (params.force && params.operation === "release") {
        if (!work.claim || work.claim.id !== params.claimId)
          return { ok: false, error: "Task claim changed; read its current state before releasing", status: 409 };
        const holder = work.claim.actor;
        if (holder.kind !== params.actor.kind || holder.id !== params.actor.id) takenOver = work.claim;
      } else {
        const check = await checkClaim(params.itemId, params.actor, params.claimId, tx);
        if (!check.ok) return check;
      }
      if (params.operation === "release") work.claim = null;
      else {
        if (!params.content) return { ok: false, error: "Progress content is required", status: 400 };
        work.progress = { content: params.content, actor: params.actor, at: new Date().toISOString() };
      }
    }
    TaskWorkSchema.parse(work);
    await tx`
      INSERT INTO spaces.task_work (item_id, claim, progress) VALUES (${params.itemId}::uuid, ${work.claim}::jsonb, ${work.progress}::jsonb)
      ON CONFLICT (item_id) DO UPDATE SET claim = EXCLUDED.claim, progress = EXCLUDED.progress
    `;
    if (takenOver)
      await recordTakeOver(
        { spaceId: params.spaceId, itemId: params.itemId, itemTitle: item.title, actor: params.actor, claim: takenOver },
        tx,
      );
    else
      await activity.record(
        {
          spaceId: params.spaceId,
          itemId: params.itemId,
          actor: params.actor,
          action: `task.${params.operation === "claim" ? "claimed" : params.operation === "release" ? "released" : "progress"}`,
          metadata: { itemTitle: item.title, ...(params.content ? { content: params.content } : {}) },
        },
        tx,
      );
    await publishSpaceChange(tx, { type: "item.updated", spaceId: params.spaceId, itemId: params.itemId });
    return { ok: true, data: work };
  });
  if (result.ok) spacesLive.wake();
  return result;
};
