/** Live execution policy shared by run admission and effect-time scope checks. */
import { type AccessSubject, getEffectiveGroupIds } from "@k2b/cloud/server";
import { accounts, toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { buildCustomAppQueryContext } from "../custom-apps/query-context";
import { customAppPageHref, resolveCustomAppPageParams } from "../custom-apps/routing";
import { customAppScannerConfigHash } from "../custom-apps/scanner-capability";
import type { GridsWorkflowChannel, GridsWorkflowPrincipal } from "../workflows/contracts";
import type { SqlClient } from "./audit";
import { get as getBase } from "./bases";
import { executePublishedCustomAppRecords } from "./custom-app-records-query";
import { publishedCustomAppAvailability } from "./custom-app-runtime-query";
import { get as getCustomApp } from "./custom-apps";
import { hasAtLeast, hasGrantsForResource, loadCustomAppGrantsForSubject, resolveEffectivePermission } from "./permission-resolver";
import { authorizeWorkflowBase, revalidateWorkflowPrincipal, revalidateWorkflowPrincipalInTransaction } from "./workflow-authorization";
import { getLauncher } from "./workflow-launchers";
import { validateWorkflowOwnerSnapshot } from "./workflow-machine-authority";
import type { GridsWorkflowAuthorization } from "./workflow-runs";

/** What deciding "may this run execute" needs, whether or not a run row exists yet. */
export type GridsWorkflowExecutionClaim = {
  channel?: GridsWorkflowChannel;
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
    getBase(app.baseId, { client: params.client }),
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
          client: params.client,
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
  const recordIds = [...new Set(Object.values(pageParams))];
  const db = params.client ?? sql;
  const records =
    recordIds.length > 0
      ? await db<Array<{ id: string; shortId: string }>>`SELECT id::text, short_id AS "shortId" FROM grids.records
        WHERE id = ANY(${toPgUuidArray(recordIds)}) AND deleted_at IS NULL`
      : [];
  const publicRecordIds = new Map(records.map((record) => [record.id, record.shortId]));
  if (publicRecordIds.size !== recordIds.length) return false;
  const publicPageParams = Object.fromEntries(Object.entries(pageParams).map(([key, id]) => [key, publicRecordIds.get(id)!]));
  const context = buildCustomAppQueryContext({
    user,
    authSubjectIds,
    app,
    base,
    page,
    pageUrl: customAppPageHref(app.shortId, page.id, publicPageParams),
    pageParams: publicPageParams,
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
      client: params.client,
      includePresentation: false,
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
  if (block.type === "actions") {
    if (action.kind === "workflow" && "background" in action && action.background) {
      return authorization.background === true && Boolean(page.record) && authorization.recordId === pageParams[page.record!.id.path];
    }
    return !authorization.background && authorization.recordId === undefined;
  }
  if (authorization.background) return false;
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
  if (!(await validateWorkflowOwnerSnapshot(claim.principal, claim.workflowId, client, claim.channel))) return false;
  if (claim.principal.mandate && claim.principal.mandate.workflowId !== claim.workflowId) return false;
  const { authorization } = claim;
  if (authorization.kind === "workflow") {
    return authorizeWorkflowBase(claim.principal, claim.baseId, "write", client);
  }
  // A machine mandate retains its base-write requirement even when a
  // published App supplies the launch capability. Use the same live policy
  // and transaction client as direct workflow execution.
  if (claim.principal.mandate && !(await authorizeWorkflowBase(claim.principal, claim.baseId, "write", client))) return false;
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
    if (!action || !("launcherId" in action) || action.launcherId !== launcher.shortId) return false;
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
    if (!block || block.type !== "scanner" || block.launcherId !== launcher.shortId) return false;
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
