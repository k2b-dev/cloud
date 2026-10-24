import { type SQL, sql, type TransactionSQL } from "bun";
import type { FilesCall, Finished, Intent } from "../service/activity";
import { FilesError } from "../service/errors";

export async function insertActivity(call: FilesCall, intent: Intent, db: SQL | TransactionSQL = sql, uploadId?: string): Promise<string> {
  const id = Bun.randomUUIDv7();
  const userId = call.kind === "user" ? (call.actor.kind === "user" ? call.actor.user.id : (call.actor.delegatedUser?.id ?? null)) : null;
  const serviceAccountId = call.kind === "user" && call.actor.kind === "service_account" ? call.actor.serviceAccount.id : null;
  const detail = {
    ...intent.detail,
    ...(intent.onConflict ? { on_conflict: intent.onConflict } : {}),
    ...(intent.writeOptions ? { write_options: intent.writeOptions } : {}),
    ...(call.kind === "system" ? { job: call.job } : {}),
  };
  // An independently committed intent is the prerequisite for every external effect.
  await db`INSERT INTO filesv2.activity(id,state,action,server_url,root,root_after,base_id,base_after_id,item_id,item_after_id,directory,name,path_before,path_after,size,revision_before,version_id,actor_kind,actor_user_id,actor_service_account_id,via,calling_app,origin,invocation_id,request_id,batch_id,share_id,upload_id,detail)
    VALUES(${id}::uuid,'pending',${intent.action},${intent.serverUrl},${intent.root},${intent.rootAfter ?? null},${intent.baseId}::uuid,${intent.baseAfterId ?? null}::uuid,${intent.itemId ?? null},${intent.itemAfterId ?? null},${intent.directory},${intent.name},${intent.pathBefore ?? null},${intent.pathAfter ?? null},${intent.size ?? null},${intent.revisionBefore ?? null},${intent.versionId ?? null},${serviceAccountId ? "service_account" : call.kind},${userId}::uuid,${serviceAccountId}::uuid,${call.kind === "user" ? call.via : call.kind === "visitor" ? "link" : "system"},${call.kind === "user" ? call.callingApp : null},${call.kind === "user" ? call.origin : null},${call.kind === "user" ? call.invocationId : null},${call.kind !== "system" ? call.requestId : null},${intent.batchId ?? null}::uuid,${call.kind === "visitor" ? call.shareId : null}::uuid,${uploadId ?? null},${detail}::jsonb)`;
  return id;
}

/** Lock the evidence before changing any journal; terminal outcomes are immutable. */
export async function finishActivity(
  tx: TransactionSQL,
  id: string,
  state: "done" | "not_done",
  finish: () => Promise<Finished>,
): Promise<void> {
  const [row] = await tx<{ state: string }[]>`SELECT state FROM filesv2.activity WHERE id=${id}::uuid FOR UPDATE`;
  if (!row) throw new FilesError("activity_scope_missing", 500);
  if (["done", "failed", "not_done"].includes(row.state)) return;
  const result = await finish();
  await tx`UPDATE filesv2.activity SET state=${state},finished_at=now(),error_code=NULL,
    item_after_id=coalesce(${result?.itemAfterId ?? null},item_after_id),size=coalesce(${result?.size ?? null},size),
    revision_after=${result?.revisionAfter ?? null},path_after=coalesce(${result?.pathAfter ?? null},path_after),
    detail=detail || ${result?.detail ?? {}}::jsonb WHERE id=${id}::uuid`;
}
