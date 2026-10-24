/**
 * Who a workflow run acts as, and where.
 *
 * A declared action is a static function — it receives a run, not the wiring
 * that started one. So the scope is read back from the run rather than closed
 * over, and it is read from the run *row*: the actor's credential and the
 * authorization it was accepted under are what decide whether the effect is
 * allowed, and neither survives a trip through the event context. A principal
 * rebuilt from `invocation.actor` alone would have no credential at all, and a
 * run started by a read-scoped API token would then act with a session's full
 * authority.
 *
 * When runs move to the kernel this reads `workflows.run` and
 * `grids.workflow_run_profile` instead. One query changes; nothing else does.
 */

import type { WorkflowActionContext } from "@k2b/cloud/workflows";
import { SQL, sql } from "bun";
import type { GridsWorkflowChannel, GridsWorkflowPrincipal } from "../workflows/contracts";
import type { SqlClient } from "./audit";
import type { DocumentIssuanceActor } from "./document-issuance";
import { authorizeWorkflowBase, canAccessWorkflowBaseTable, workflowTableBelongsToBase } from "./workflow-authorization";
import { canExecuteWorkflow, type GridsWorkflowExecutionClaim } from "./workflow-execution-authorization";
import { type GridsWorkflowAuthorization, getWorkflowRunScope } from "./workflow-runs";

export { canExecuteWorkflow } from "./workflow-execution-authorization";

type PermissionLevel = "read" | "write" | "admin";

export type GridsWorkflowActionScope = {
  runId: string;
  channel: GridsWorkflowChannel;
  baseId: string;
  /** Display identity, for what an email template renders. */
  workflow: { id: string; shortId: string; name: string };
  principal: GridsWorkflowPrincipal;
  authorization: GridsWorkflowAuthorization;
  launcherId: string | null;
};

export const documentActorForScope = (scope: Pick<GridsWorkflowActionScope, "principal">): DocumentIssuanceActor => {
  const serviceAccountId = scope.principal.actorServiceAccountId ?? scope.principal.serviceAccountId;
  if (serviceAccountId)
    return {
      kind: "service_account",
      serviceAccountId,
      delegatedUserId: scope.principal.userId,
      credentialId: scope.principal.credential?.id ?? null,
    };
  return scope.principal.userId ? { kind: "user", userId: scope.principal.userId } : { kind: "system" };
};

/**
 * A failure an action can describe, rather than one that escapes it.
 *
 * The code reaches the run view, so an operator can tell a deleted template
 * from a revoked grant; `retryable` says the attempt failed and not the work.
 */
export class GridsWorkflowActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "GridsWorkflowActionError";
  }
}

export const actionError = (code: string, message: string, retryable = false): GridsWorkflowActionError =>
  new GridsWorkflowActionError(code, message, retryable);

const forbidden = (): GridsWorkflowActionError => actionError("FORBIDDEN", "Workflow actor does not have permission for this action");

/** A service `Result` refused: its own code and status decide how it is reported. */
export const requireOk = <T>(
  result: { ok: true; data: T } | { ok: false; error: { code: string; message: string; status?: number } },
): T => {
  if (result.ok) return result.data;
  const { code, message, status } = result.error;
  throw actionError(code || "GRIDS_ACTION_FAILED", message, status !== undefined && status >= 500);
};

export const workflowRunScope = (ctx: Pick<WorkflowActionContext, "runId">, client?: SqlClient): Promise<GridsWorkflowActionScope> =>
  getWorkflowRunScope(ctx.runId, client).then((scope) => {
    if (!scope) throw actionError("NOT_FOUND", "Workflow run is no longer available");
    return scope;
  });

export const canExecuteRun = (scope: GridsWorkflowActionScope, client?: SqlClient): Promise<boolean> =>
  canExecuteWorkflow({ ...scope, workflowId: scope.workflow.id }, client);

/** The HTTP request's abort budget also owns its final database decision. */
export const canExecuteRunBeforeHttp = async (scope: GridsWorkflowActionScope, signal: AbortSignal): Promise<boolean> => {
  signal.throwIfAborted();
  // Keep a cancellation connection independent of both the shared pool and
  // the authorization transaction. Closing this pool never affects app work.
  const pool = new SQL({ ...sql.options, max: 2 });
  let cancellation: Promise<unknown> | undefined;
  let abort: (() => void) | undefined;
  let control: Awaited<ReturnType<typeof pool.reserve>> | undefined;
  let connection: Awaited<ReturnType<typeof pool.reserve>> | undefined;
  try {
    control = await pool.reserve({ signal });
    signal.throwIfAborted();
    connection = await pool.reserve({ signal });
    signal.throwIfAborted();
    return await connection.begin(async (tx) => {
      const [backend] = await tx<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
      if (!backend) throw new Error("HTTP authorization has no PostgreSQL backend");
      const cancel = control!;
      const cancelled = Promise.withResolvers<never>();
      abort = () => {
        cancellation ??= cancel`SELECT pg_cancel_backend(${backend.pid})`.execute().finally(() => pool.close({ timeout: 0 }));
        // The owner awaits cleanup below; keep rejection handled meanwhile.
        void cancellation.catch(() => undefined);
        cancelled.reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      // Registry reads have no per-reader cancellation.
      // Release this waiter on abort, then await our SQL cleanup in finally.
      const decision = Promise.race([canExecuteRun(scope, tx), cancelled.promise]);
      if (signal.aborted) abort();
      const allowed = await decision;
      signal.throwIfAborted();
      return allowed;
    });
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    await cancellation?.catch(() => undefined);
    connection?.release();
    control?.release();
    await pool.close({ timeout: 0 });
  }
};

export const canAccessWorkflowExecutionTable = async (
  claim: GridsWorkflowExecutionClaim,
  tableId: string,
  required: PermissionLevel,
  client?: SqlClient,
): Promise<boolean> => {
  if (claim.authorization.kind === "workflow") {
    return canAccessWorkflowBaseTable(claim.principal, { baseId: claim.baseId, tableId }, required, client);
  }
  if (!(await workflowTableBelongsToBase(claim.baseId, tableId, client))) return false;
  return canExecuteWorkflow(claim, client);
};

export const requireExecution = async (scope: GridsWorkflowActionScope, client?: SqlClient): Promise<void> => {
  if (!(await canExecuteRun(scope, client))) throw forbidden();
};

export const requirePermission = async (scope: GridsWorkflowActionScope, required: PermissionLevel, client?: SqlClient): Promise<void> => {
  const allowed =
    scope.authorization.kind !== "workflow"
      ? await canExecuteRun(scope, client)
      : await authorizeWorkflowBase(scope.principal, scope.baseId, required, client);
  if (!allowed) throw forbidden();
};

export const canAccessWorkflowRunTable = async (
  scope: GridsWorkflowActionScope,
  tableId: string,
  required: PermissionLevel,
  client?: SqlClient,
): Promise<boolean> => {
  return canAccessWorkflowExecutionTable({ ...scope, workflowId: scope.workflow.id }, tableId, required, client);
};

/** One read authorization decision for one query capture. The caller creates
 * this inside the capture transaction and uses the client-bound checker only
 * for that capture. Effect/commit authorization stays separate.
 */
export const createWorkflowCaptureTableAccess = async (
  scope: GridsWorkflowActionScope,
  client: SqlClient,
  deps = { authorizeWorkflowBase, canExecuteRun, workflowTableBelongsToBase },
): Promise<(tableId: string) => Promise<boolean>> => {
  const allowed =
    scope.authorization.kind === "workflow"
      ? await deps.authorizeWorkflowBase(scope.principal, scope.baseId, "read", client)
      : await deps.canExecuteRun(scope, client);
  return async (tableId) => allowed && (await deps.workflowTableBelongsToBase(scope.baseId, tableId, client));
};

export const requireTableAccess = async (
  scope: GridsWorkflowActionScope,
  tableId: string,
  required: PermissionLevel,
  client?: SqlClient,
): Promise<void> => {
  if (!(await canAccessWorkflowRunTable(scope, tableId, required, client))) throw forbidden();
};

/** A single atomic effect's authority, created after its domain locks and lease
 * fence. Availability is a precondition, not a postcondition of our own writes.
 * Never retain this context beyond its transaction or reuse it for a retry.
 */
export const createWorkflowEffectAccess = async (
  scope: GridsWorkflowActionScope,
  client: SqlClient,
  deps = { canExecuteRun, workflowTableBelongsToBase },
) => {
  const allowed = await deps.canExecuteRun(scope, client);
  if (!allowed) throw forbidden();
  const canReadTable = (tableId: string): Promise<boolean> => deps.workflowTableBelongsToBase(scope.baseId, tableId, client);
  const requireTable = async (tableId: string): Promise<void> => {
    if (!(await canReadTable(tableId))) throw forbidden();
  };
  return { scope, canReadTable, requireTable };
};

export type WorkflowEffectAccess = Awaited<ReturnType<typeof createWorkflowEffectAccess>>;

/** Provenance an audit entry carries, so a write can be traced back to its credential. */
export const workflowAuditMeta = (scope: GridsWorkflowActionScope) => ({
  workflowId: scope.workflow.id,
  workflowRunId: scope.runId,
  actorServiceAccountId: scope.principal.actorServiceAccountId ?? null,
  credentialId: scope.principal.credential?.id ?? null,
  credentialKind: scope.principal.credential?.kind ?? null,
  credentialScopes: scope.principal.credential?.scopes ?? [],
  credentialPermissionCap: scope.principal.credential?.permissionCap ?? null,
  credentialResourceBinding: scope.principal.credential?.resourceBinding ?? null,
  mandateId: scope.principal.mandate?.id ?? null,
  mandateRevision: scope.principal.mandate?.revision ?? null,
});

export const actorId = (scope: GridsWorkflowActionScope): string | null => scope.principal.userId;
