import type { RequestActor } from "@k2b/cloud/server";
import { type Mandate, mandates } from "@k2b/cloud/services";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import type { GridsWorkflowPrincipal, WorkflowMachineAuthorityChange } from "../workflows/contracts";
import { hasTransactionalBaseAdmin, lockBaseAuthorization } from "./access";
import { logAudit, type SqlClient } from "./audit";
import { gridsLive, publishMetadataChange } from "./live";
import { hasAtLeast, loadBaseGrantsForSubject, resolveEffectivePermission } from "./permission-resolver";
import { getWorkflow } from "./workflow-read";
import { emitWorkflowRuntimeEvent } from "./workflow-runtime-events";

export async function getWorkflowMachineAuthority(workflowId: string, db: SqlClient = sql) {
  const [row] = await db<
    {
      owner_user_id: string | null;
      owner_service_account_id: string | null;
      machine_mandate_id: string | null;
      name: string | null;
      kind: "agent" | "standalone" | null;
      status: string | null;
    }[]
  >`
    SELECT p.owner_user_id, p.owner_service_account_id, p.machine_mandate_id, sa.name, sa.kind, sa.status
    FROM grids.workflow_profile p LEFT JOIN auth.service_accounts sa ON sa.id=p.owner_service_account_id
    WHERE p.id=${workflowId}::uuid AND p.deleted_at IS NULL`;
  if (!row) return null;
  const mandate = row.machine_mandate_id ? await mandates.get(row.machine_mandate_id, { db }) : null;
  return {
    ownerUserId: row.owner_user_id,
    serviceAccountId: row.owner_service_account_id,
    name: row.name,
    kind: row.kind,
    accountStatus: row.status,
    mandate,
  };
}

export async function machineWorkflowOwnerPrincipal(workflowId: string): Promise<GridsWorkflowPrincipal | null> {
  const authority = await getWorkflowMachineAuthority(workflowId);
  if (!authority?.serviceAccountId) return null;
  return {
    userId: null,
    serviceAccountId: authority.serviceAccountId,
    actorServiceAccountId: authority.serviceAccountId,
    groupIds: [],
    mandate: authority.mandate ? { id: authority.mandate.id, revision: authority.mandate.revision, workflowId } : null,
  };
}

export async function validateWorkflowMachineMandate(
  principal: GridsWorkflowPrincipal,
  baseId: string,
  db: SqlClient = sql,
): Promise<boolean> {
  if (
    !principal.mandate ||
    principal.userId ||
    !principal.serviceAccountId ||
    principal.actorServiceAccountId !== principal.serviceAccountId
  )
    return false;
  const reference = principal.mandate;
  // Account deletion cascades through mandates into profiles. Take the same
  // order, and hold account status stable for the effect transaction too.
  const [account] = await db`SELECT id FROM auth.service_accounts
    WHERE id=${principal.serviceAccountId}::uuid AND kind IN ('standalone','agent') AND status='active' FOR SHARE`;
  if (!account) return false;
  const authority = await mandates.validateIssueAuthority(
    { mandateId: reference.id, expectedRevision: reference.revision, ownerAppId: "grids", targetAppId: "grids", operation: "workflow.run" },
    { db },
  );
  if (
    !authority.ok ||
    authority.data.subject.type !== "service_account" ||
    authority.data.subject.id !== principal.serviceAccountId ||
    authority.data.workloadType !== "grids.workflow" ||
    authority.data.workloadId !== reference.workflowId
  )
    return false;
  const [profile] = await db`SELECT id FROM grids.workflow_profile
    WHERE id=${reference.workflowId}::uuid AND base_id=${baseId}::uuid AND owner_service_account_id=${principal.serviceAccountId}::uuid
      AND machine_mandate_id=${reference.id}::uuid AND deleted_at IS NULL AND enabled=TRUE FOR SHARE`;
  return Boolean(profile);
}

/** Choosing another execution identity requires installation authority as well as base management. */
export async function configureWorkflowMachineAuthority(params: {
  actor: RequestActor;
  workflowId: string;
  change: WorkflowMachineAuthorityChange;
}): Promise<Result<NonNullable<Awaited<ReturnType<typeof getWorkflowMachineAuthority>>>>> {
  const actor = params.actor;
  if (actor.kind !== "user" || actor.sessionKind === "app" || !actor.user.roles.includes("admin"))
    return fail(err.forbidden("An administrator is required to assign machine authority"));
  const workflow = await getWorkflow(params.workflowId);
  if (!workflow) return fail(err.notFound("Workflow"));
  const changed = await sql.begin(async (db): Promise<Result<void>> => {
    const initial = await getWorkflowMachineAuthority(workflow.id, db);
    if (!initial) return fail(err.notFound("Workflow"));
    // Match account deletion's account -> mandate -> profile cascade. Lock both
    // sides of reassignment before base authorization, in a stable order.
    const accountIds = new Set(initial.serviceAccountId ? [initial.serviceAccountId] : []);
    if (params.change.action === "assign") accountIds.add(params.change.serviceAccountId);
    for (const id of [...accountIds].sort()) {
      await db`SELECT id FROM auth.service_accounts WHERE id=${id}::uuid FOR SHARE`;
    }
    await lockBaseAuthorization([workflow.baseId], db);
    if (
      !(await hasTransactionalBaseAdmin(
        workflow.baseId,
        {
          subject: { type: "user", userId: actor.user.id },
          permissionCap: "admin",
        },
        db,
      ))
    )
      return fail(err.forbidden("Workflow management is required"));
    if (initial.mandate) await db`SELECT id FROM auth.mandates WHERE id=${initial.mandate.id}::uuid FOR UPDATE`;
    const [profile] = await db`SELECT id FROM grids.workflow_profile
      WHERE id=${workflow.id}::uuid AND base_id=${workflow.baseId}::uuid AND deleted_at IS NULL FOR UPDATE`;
    if (!profile) return fail(err.notFound("Workflow"));
    const current = await getWorkflowMachineAuthority(workflow.id, db);
    const expected = params.change.expected;
    if (
      !current ||
      current.ownerUserId !== initial.ownerUserId ||
      current.serviceAccountId !== initial.serviceAccountId ||
      current.mandate?.id !== initial.mandate?.id ||
      current.serviceAccountId !== expected.serviceAccountId ||
      (current.mandate?.id ?? null) !== (expected.mandate?.id ?? null) ||
      (current.mandate?.revision ?? null) !== (expected.mandate?.revision ?? null)
    )
      return fail(err.conflict("Workflow execution authority changed; reload before trying again"));
    const authority = { kind: "admin" as const, userId: actor.user.id };
    let result: Result<Mandate>;
    if (params.change.action === "assign") {
      const accountId = params.change.serviceAccountId;
      const [account] =
        await db`SELECT id FROM auth.service_accounts WHERE id=${accountId}::uuid AND kind IN ('standalone','agent') AND status='active' FOR SHARE`;
      if (!account) return fail(err.badInput("Choose an active agent or service account"));
      const grants = await loadBaseGrantsForSubject(
        { subject: { type: "service_account", serviceAccountId: accountId }, baseId: workflow.baseId },
        db,
      );
      if (!hasAtLeast(resolveEffectivePermission(grants, { baseId: workflow.baseId }), "write"))
        return fail(err.forbidden("The machine needs its own base write grant"));
      if (current?.mandate && current.mandate.state !== "revoked") {
        const revoked = await mandates.revoke(
          {
            authority,
            mandateId: current.mandate.id,
            expectedRevision: current.mandate.revision,
            reason: "Workflow execution owner reassigned",
          },
          { db },
        );
        if (!revoked.ok) return revoked;
      }
      result = await mandates.create(
        {
          authority,
          subject: { type: "service_account", id: accountId },
          ownerAppId: "grids",
          workloadType: "grids.workflow",
          workloadId: workflow.id,
          policy: { version: 1, apps: ["grids"], operations: ["workflow.run"], actions: "deny" },
        },
        { db },
      );
      if (!result.ok) throw new Error(result.error.message);
      await db`UPDATE grids.workflow_profile SET owner_user_id=NULL,owner_service_account_id=${accountId}::uuid,machine_mandate_id=${result.data.id}::uuid,updated_at=now() WHERE id=${workflow.id}::uuid`;
    } else {
      if (!current?.mandate) return fail(err.notFound("Workflow mandate"));
      const input = { authority, mandateId: current.mandate.id, expectedRevision: current.mandate.revision };
      result =
        params.change.action === "pause"
          ? await mandates.pause(input, { db })
          : params.change.action === "resume"
            ? await mandates.resume(input, { db })
            : await mandates.revoke({ ...input, reason: "Workflow machine authority revoked" }, { db });
      if (!result.ok) return result;
    }
    await logAudit(
      {
        baseId: workflow.baseId,
        userId: actor.user.id,
        action: "workflow.updated",
        diff: {
          machineAuthority: {
            old: current?.mandate ? { id: current.mandate.id, state: current.mandate.state } : null,
            new: { id: result.data.id, state: result.data.state, revision: result.data.revision, subject: result.data.subject },
          },
        },
      },
      db,
    );
    await publishMetadataChange(db, workflow.baseId, "workflow.updated");
    return ok();
  });
  if (!changed.ok) return changed;
  await gridsLive.wake();
  await emitWorkflowRuntimeEvent(workflow.id);
  const current = await getWorkflowMachineAuthority(workflow.id);
  return current ? ok(current) : fail(err.notFound("Workflow"));
}
