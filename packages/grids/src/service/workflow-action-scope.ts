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

import { type AccessSubject, getEffectiveGroupIds } from "@valentinkolb/cloud/server";
import { accounts } from "@valentinkolb/cloud/services";
import type { WorkflowActionContext } from "@valentinkolb/cloud/workflows";
import { buildCustomAppQueryContext } from "../custom-apps/query-context";
import { customAppPageHref, resolveCustomAppPageParams } from "../custom-apps/routing";
import { customAppScannerConfigHash } from "../custom-apps/scanner-capability";
import type { GridsWorkflowPrincipal } from "../workflows/contracts";
import type { SqlClient } from "./audit";
import { get as getBase } from "./bases";
import { executePublishedCustomAppRecords } from "./custom-app-records-query";
import { publishedCustomAppAvailability } from "./custom-app-runtime-query";
import { get as getCustomApp } from "./custom-apps";
import { hasAtLeast, hasGrantsForResource, loadCustomAppGrantsForSubject, resolveEffectivePermission } from "./permission-resolver";
import {
  authorizeWorkflowBase,
  canAccessWorkflowBaseTable,
  revalidateWorkflowPrincipal,
  revalidateWorkflowPrincipalInTransaction,
  workflowTableBelongsToBase,
} from "./workflow-authorization";
import { getLauncher } from "./workflow-launchers";
import { type GridsWorkflowAuthorization, getWorkflowRunScope } from "./workflow-runs";

export type PermissionLevel = "read" | "write" | "admin";

export type GridsWorkflowActionScope = {
  runId: string;
  baseId: string;
  /** Display identity, for what an email template renders. */
  workflow: { id: string; shortId: string; name: string };
  principal: GridsWorkflowPrincipal;
  authorization: GridsWorkflowAuthorization;
  launcherId: string | null;
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

export const forbidden = (): GridsWorkflowActionError =>
  actionError("FORBIDDEN", "Workflow actor does not have permission for this action");

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

/** What deciding "may this run execute" needs, whether or not a run row exists yet. */
export type GridsWorkflowExecutionClaim = {
  baseId: string;
  workflowId: string;
  principal: GridsWorkflowPrincipal;
  authorization: GridsWorkflowAuthorization;
  launcherId: string | null | undefined;
};

const sameStringRecord = (left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean => {
  const leftEntries = Object.entries(left).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  const rightEntries = Object.entries(right).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
};

type PublishedApp = NonNullable<Awaited<ReturnType<typeof getCustomApp>>>;
const customAppAuthorizationIsAvailable = async (params: {
  app: PublishedApp;
  authorization: Exclude<GridsWorkflowAuthorization, { kind: "workflow" }>;
  subject: AccessSubject;
  client?: SqlClient;
}): Promise<boolean> => {
  // Effect-time authorization is deliberately narrower-owned than HTTP
  // runtime resolution: it runs with a transaction client and frozen launch
  // context, then replays current availability and Records membership.
  const { app, authorization } = params;
  if (!app.publishedDefinition || !app.publishedCapabilities || app.publishedAt !== authorization.publishedAt) return false;
  const userId = params.subject.type === "user" ? params.subject.userId : null;
  const [base, user, groupIds] = await Promise.all([
    getBase(app.baseId),
    userId ? accounts.users.get({ id: userId }) : null,
    getEffectiveGroupIds({ userId }, params.client),
  ]);
  if (!base || (userId && !user)) return false;
  const viewer = {
    userId,
    userGroups: groupIds,
    serviceAccountId: params.subject.type === "service_account" ? params.subject.serviceAccountId : null,
    isAdmin: true,
  };
  const authSubjectIds = user ? [user.id, ...groupIds] : [];

  const evaluate = async (
    source: string | undefined,
    capability: (typeof app.publishedCapabilities.availability)[number] | undefined,
    context: ReturnType<typeof buildCustomAppQueryContext>,
  ): Promise<boolean> => {
    if (!source) return true;
    const available = Boolean(
      capability &&
        (await publishedCustomAppAvailability({
          baseId: app.baseId,
          source,
          capability,
          context,
          signal: new AbortController().signal,
          timeZone: authorization.timeZone,
          viewer,
        })),
    );
    return available;
  };

  if (authorization.kind === "custom-app-sidebar-action") {
    const action = app.publishedDefinition.sidebar?.actions.find((candidate) => candidate.id === authorization.actionId);
    if (!action) return false;
    const context = buildCustomAppQueryContext({
      user,
      authSubjectIds,
      app,
      base,
      page: { id: "global", title: app.name },
      pageUrl: `/apps/${encodeURIComponent(app.shortId)}`,
      pageParams: {},
      dateConfig: { timeZone: authorization.timeZone },
      now: new Date(),
    });
    const capability = app.publishedCapabilities.availability.find(
      (candidate) => candidate.target === "sidebarAction" && candidate.actionId === action.id,
    );
    return evaluate(action.availableWhen?.query, capability, context);
  }

  const page = app.publishedDefinition.pages.find((candidate) => candidate.id === authorization.pageId);
  const pageParams = page ? resolveCustomAppPageParams(page, authorization.pageParams) : null;
  if (!page || !pageParams || !sameStringRecord(pageParams, authorization.pageParams)) return false;
  const context = buildCustomAppQueryContext({
    user,
    authSubjectIds,
    app,
    base,
    page,
    pageUrl: customAppPageHref(app.shortId, page.id, pageParams),
    pageParams,
    dateConfig: { timeZone: authorization.timeZone },
    now: new Date(),
  });
  const pageCapability = app.publishedCapabilities.availability.find(
    (candidate) => candidate.target === "page" && candidate.pageId === page.id,
  );
  if (!(await evaluate(page.availableWhen?.query, pageCapability, context))) return false;

  const block = page.rows
    .flatMap((row) => row.columns.flatMap((column) => column.blocks))
    .find((candidate) => candidate.id === authorization.blockId);
  if (!block) return false;
  const blockCapability = app.publishedCapabilities.availability.find(
    (candidate) => candidate.target === "block" && candidate.pageId === page.id && candidate.blockId === block.id,
  );
  if (!(await evaluate(block.availableWhen?.query, blockCapability, context))) return false;
  const recordsContain = async (recordIds: readonly string[], search?: string, cursor?: string): Promise<boolean> => {
    if (block.type !== "records" && block.type !== "referenced_records") return false;
    const published = await executePublishedCustomAppRecords({
      baseId: app.baseId,
      customAppId: app.id,
      publishedAt: authorization.publishedAt,
      page,
      pageParams,
      block,
      capabilities: app.publishedCapabilities!,
      context,
      signal: new AbortController().signal,
      timeZone: authorization.timeZone,
      viewer,
      viewerUserId: userId,
      viewerServiceAccountId: viewer.serviceAccountId,
      search,
      cursor,
    }).catch(() => null);
    if (!published?.response.ok) return false;
    const visibleIds = new Set(published.response.rows.flatMap((row) => (row.recordId ? [row.recordId] : [])));
    return recordIds.every((recordId) => visibleIds.has(recordId));
  };
  if (authorization.kind === "custom-app-bulk-action") {
    return recordsContain(authorization.recordIds, authorization.search, authorization.cursor);
  }
  if (authorization.kind !== "custom-app-action") return true;

  const action =
    block.type === "actions"
      ? block.actions.find((candidate) => candidate.id === authorization.actionId)
      : block.type === "records" || block.type === "referenced_records"
        ? block.rowActions?.find((candidate) => candidate.id === authorization.actionId)
        : null;
  if (!action) return false;
  const actionCapability = app.publishedCapabilities.availability.find(
    (candidate) =>
      candidate.target === "action" && candidate.pageId === page.id && candidate.blockId === block.id && candidate.actionId === action.id,
  );
  if (!(await evaluate(action.availableWhen?.query, actionCapability, context))) return false;
  if (block.type !== "records" && block.type !== "referenced_records") return authorization.recordId === undefined;
  if (!authorization.recordId) return false;
  return recordsContain([authorization.recordId], authorization.search, authorization.cursor);
};

/**
 * Whether this actor may still execute this workflow.
 *
 * An indirectly launched run is authorized by the published surface that
 * launched it, not by a grant on the workflow. The surface, action and launcher
 * must still agree at effect time because any of them can change while a run is
 * queued.
 */
export const canExecuteWorkflow = async (claim: GridsWorkflowExecutionClaim, client?: SqlClient): Promise<boolean> => {
  const { authorization } = claim;
  if (authorization.kind === "workflow") {
    return authorizeWorkflowBase(claim.principal, claim.baseId, "write", client);
  }
  const revalidated = client
    ? await revalidateWorkflowPrincipalInTransaction(claim.principal, claim.baseId, client)
    : await revalidateWorkflowPrincipal(claim.principal, claim.baseId);
  if (!revalidated.ok || !hasAtLeast(revalidated.permissionCap, "write")) return false;
  if (!claim.launcherId) return false;
  // Removed v3 launch surfaces fail closed for already queued runs.
  if (authorization.kind === "custom-app-bulk-action" || authorization.kind === "custom-app-sidebar-action") return false;
  if (authorization.kind === "custom-app-action") {
    const [app, launcher] = await Promise.all([getCustomApp(authorization.customAppId, client), getLauncher(claim.launcherId, client)]);
    if (
      !app?.publishedDefinition ||
      !app.publishedCapabilities ||
      app.baseId !== claim.baseId ||
      !launcher ||
      launcher.baseId !== claim.baseId ||
      launcher.workflowId !== claim.workflowId ||
      launcher.config.kind !== "customApp" ||
      !launcher.enabled ||
      launcher.validatedRevision !== authorization.revision ||
      launcher.diagnostics.some((diagnostic) => diagnostic.severity === "error")
    ) {
      return false;
    }
    const grants = await loadCustomAppGrantsForSubject({ subject: revalidated.subject, customAppId: app.id }, client);
    if (
      !hasGrantsForResource(grants, "customApp", app.id) ||
      !hasAtLeast(resolveEffectivePermission(grants, { customAppId: app.id }), "read")
    ) {
      return false;
    }
    const page = app.publishedDefinition.pages.find((candidate) => candidate.id === authorization.pageId);
    const block = page?.rows
      .flatMap((row) => row.columns.flatMap((column) => column.blocks))
      .find(
        (candidate) =>
          candidate.id === authorization.blockId &&
          (candidate.type === "actions" || candidate.type === "records" || candidate.type === "referenced_records"),
      );
    const action =
      block?.type === "actions"
        ? block.actions.find((candidate) => candidate.id === authorization.actionId)
        : block?.type === "records" || block?.type === "referenced_records"
          ? block.rowActions?.find((candidate) => candidate.id === authorization.actionId)
          : null;
    if (!action || !("launcherId" in action) || action.launcherId !== claim.launcherId) return false;
    const capabilityMatches = app.publishedCapabilities.workflowLaunchers.some(
      (capability) =>
        "pageId" in capability &&
        capability.pageId === page!.id &&
        capability.blockId === block!.id &&
        capability.actionId === action.id &&
        capability.launcherId === claim.launcherId &&
        capability.workflowId === claim.workflowId &&
        capability.revision === authorization.revision,
    );
    return capabilityMatches && customAppAuthorizationIsAvailable({ app, authorization, subject: revalidated.subject, client });
  }
  if (authorization.kind === "custom-app-scanner") {
    const [app, launcher] = await Promise.all([getCustomApp(authorization.customAppId, client), getLauncher(claim.launcherId, client)]);
    if (
      !app?.publishedDefinition ||
      !app.publishedCapabilities ||
      app.baseId !== claim.baseId ||
      !launcher ||
      launcher.baseId !== claim.baseId ||
      launcher.workflowId !== claim.workflowId ||
      launcher.config.kind !== "scanner" ||
      !launcher.enabled ||
      launcher.validatedRevision !== authorization.revision ||
      launcher.diagnostics.some((diagnostic) => diagnostic.severity === "error") ||
      customAppScannerConfigHash(launcher.config) !== authorization.configHash
    ) {
      return false;
    }
    const grants = await loadCustomAppGrantsForSubject({ subject: revalidated.subject, customAppId: app.id }, client);
    if (
      !hasGrantsForResource(grants, "customApp", app.id) ||
      !hasAtLeast(resolveEffectivePermission(grants, { customAppId: app.id }), "read")
    ) {
      return false;
    }
    const page = app.publishedDefinition.pages.find((candidate) => candidate.id === authorization.pageId);
    const block = page?.rows
      .flatMap((row) => row.columns.flatMap((column) => column.blocks))
      .find((candidate) => candidate.id === authorization.blockId);
    if (!block || block.type !== "scanner" || block.launcherId !== claim.launcherId) return false;
    const capabilityMatches = app.publishedCapabilities.scannerLaunchers.some(
      (capability) =>
        capability.pageId === page!.id &&
        capability.blockId === block.id &&
        capability.launcherId === claim.launcherId &&
        capability.workflowId === claim.workflowId &&
        capability.revision === authorization.revision &&
        capability.configHash === authorization.configHash,
    );
    return capabilityMatches && customAppAuthorizationIsAvailable({ app, authorization, subject: revalidated.subject, client });
  }
  return false;
};

export const canExecuteRun = (scope: GridsWorkflowActionScope, client?: SqlClient): Promise<boolean> =>
  canExecuteWorkflow({ ...scope, workflowId: scope.workflow.id }, client);

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

export const requireTableAccess = async (
  scope: GridsWorkflowActionScope,
  tableId: string,
  required: PermissionLevel,
  client?: SqlClient,
): Promise<void> => {
  if (!(await canAccessWorkflowRunTable(scope, tableId, required, client))) throw forbidden();
};

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
});

export const actorId = (scope: GridsWorkflowActionScope): string | null => scope.principal.userId;
