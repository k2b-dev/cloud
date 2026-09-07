import { err, fail, isServiceError, ok, type Result, unwrap } from "@k2b/stdlib";
import type { PumpState, Worker } from "@k2b/sync";
import { lazySync } from "@valentinkolb/cloud";
import { audit, mandates, toPgTextArray, toPgUuidArray, trace } from "@valentinkolb/cloud/services";
import type { WorkflowJsonValue } from "@valentinkolb/cloud/workflows";
import { emitWorkflowEvent } from "@valentinkolb/cloud/workflows/store";
import { sql } from "bun";
import {
  type CreateIncomingAutomation,
  createIncomingAutomationSchema,
  type DeleteIncomingAutomation,
  deleteIncomingAutomationSchema,
  type IncomingAutomationBackfill,
  type IncomingAutomationMatchPreview,
  type MailAutomationAction,
  type MailAutomationCondition,
  type MailAutomationConditions,
  type MailAutomationScope,
  type MailAutomationStep,
  type PreviewIncomingAutomationMatchesInput,
  previewIncomingAutomationMatchesInputSchema,
  type SenderMatchKind,
  type SetIncomingAutomationEnabled,
  type StartIncomingAutomationBackfillInput,
  setIncomingAutomationEnabledSchema,
  startIncomingAutomationBackfillInputSchema,
  type UpdateIncomingAutomation,
  updateIncomingAutomationSchema,
} from "../contracts";
import { withShortIdDb } from "../lib/short-id";
import { type MailWorkflowCatalogSnapshot, snapshotMailWorkflowCatalog } from "../workflows/catalog";
import { MAIL_WORKFLOW_APP_ID, MAIL_WORKFLOW_EVENT } from "../workflows/events";
import { requireMailboxPermission } from "./access";
import { normalizeEmailAddress, normalizeEmailDomain } from "./address-normalization";
import { actorRefFromRequest, auditActorFromRequest, type MailRequestContext, userBackedActor } from "./auth";
import { sha256Json } from "./canonical";
import { databaseErrorCode } from "./database-errors";
import { publishMailMailboxEvent } from "./events";
import { incomingAutomationMandatePolicy } from "./incoming-automation-authority";
import {
  buildIncomingAutomationWorkflowSource,
  incomingAutomationActions,
  incomingAutomationBudget,
  incomingAutomationHasAi,
  incomingAutomationHasSpaces,
} from "./incoming-automation-definition";
import { withLeaseHeartbeat } from "./lease-heartbeat";
import { loadMailWorkflowCatalog } from "./workflow-catalog-service";
import type { SqlClient } from "./workflow-data";
import { getWorkflowSnapshot, mailWorkflowEventContext } from "./workflow-data";
import {
  replaceManagedWorkflowInTransaction,
  setManagedWorkflowEnabledInTransaction,
  validateMailWorkflowSource,
} from "./workflow-definition-service";

export type IncomingAutomation = {
  id: string;
  mailboxId: string;
  workflowId: string;
  workflowVersionId: string;
  name: string;
  enabled: boolean;
  scope: MailAutomationScope;
  steps: MailAutomationStep[];
  latestBackfillOperationId: string | null;
  workflowSource: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};
type StoredIncomingAutomation = IncomingAutomation & {
  mandateId: string | null;
};

export type IncomingAutomationActivityMetadata = Pick<IncomingAutomation, "id" | "workflowId" | "name">;

type IncomingAutomationRow = {
  id: string;
  mailbox_id: string;
  workflow_id: string;
  workflow_version_id: string;
  name: string;
  enabled: boolean;
  scope: MailAutomationScope | string;
  steps: MailAutomationStep[] | string;
  latest_backfill_operation_id: string | null;
  workflow_source: string;
  revision: string | number;
  created_at: Date | string;
  updated_at: Date | string;
  mandate_id: string | null;
};

type AutomationActor = { kind: "user" | "service_account"; id: string };
type AutomationConditionSet = { mode: MailAutomationConditions["mode"]; items: MailAutomationCondition[] };

const incomingAutomationColumns = sql`
  automation.id,
  automation.mailbox_id,
  automation.workflow_id,
  (
    SELECT workflow.active_version_id
    FROM workflows.workflow workflow
    WHERE workflow.id = automation.workflow_id
  ) AS workflow_version_id,
  automation.name,
  automation.enabled,
  automation.scope,
  automation.steps,
  automation.latest_backfill_operation_id,
  (
    SELECT version.source
    FROM workflows.workflow workflow
    JOIN workflows.version version ON version.id = workflow.active_version_id
    WHERE workflow.id = automation.workflow_id
  ) AS workflow_source,
  automation.revision,
  automation.created_at,
  automation.updated_at
  , automation.mandate_id
`;

const mandateAuthority = (context: MailRequestContext) => {
  if (context.actor.kind !== "user") return null;
  const user = context.actor.user;
  return { kind: "interactive" as const, userId: user.id };
};
const mandateWorkloadAuthority = { kind: "workload" as const, ownerAppId: "mail" };

const createAutomationMandate = async (context: MailRequestContext, automationId: string, steps: MailAutomationStep[], db: SqlClient) => {
  const authority = mandateAuthority(context);
  const policy = incomingAutomationMandatePolicy(steps);
  if (!authority || !policy) return fail(err.forbidden("Spaces automation mandates require an interactive user"));
  return mandates.create(
    {
      authority,
      subject: { type: "user", id: authority.userId },
      ownerAppId: "mail",
      workloadType: "incoming.automation",
      workloadId: automationId,
      policy,
    },
    { db },
  );
};

const updateAutomationMandate = async (context: MailRequestContext, mandateId: string, steps: MailAutomationStep[], db: SqlClient) => {
  const authority = mandateAuthority(context);
  const policy = incomingAutomationMandatePolicy(steps);
  if (!authority || !policy) return fail(err.forbidden("Spaces automation mandates require an interactive user"));
  const current = await mandates.get(mandateId, { db });
  if (!current) return fail(err.forbidden("This automation has no active Spaces authorization"));
  // An equal operation allowlist does not prove that new targets or payloads
  // stay within the original user's approval of this automation definition.
  if (current.subject.type !== "user" || current.subject.id !== authority.userId) {
    return fail(err.forbidden("Changing this automation's Spaces configuration requires reauthorization by the user who authorized it"));
  }
  return mandates.updatePolicy({ mandateId, expectedRevision: current.revision, authority, policy }, { db });
};

const revokeAutomationMandate = async (mandateId: string, reason: string, db: SqlClient): Promise<Result<unknown>> => {
  const current = await mandates.get(mandateId, { db });
  if (!current) return ok(null);
  return mandates.revoke({ mandateId, expectedRevision: current.revision, authority: mandateWorkloadAuthority, reason }, { db });
};

const syncAutomationMandateEnabled = async (
  context: MailRequestContext,
  mandateId: string,
  enabled: boolean,
  db: SqlClient,
): Promise<Result<unknown>> => {
  const current = await mandates.get(mandateId, { db });
  if (!current) return fail(err.forbidden("This automation has no Spaces authorization"));
  if (enabled) {
    const authority = mandateAuthority(context);
    if (!authority || current.subject.type !== "user" || current.subject.id !== authority.userId) {
      return fail(err.forbidden("Enabling this automation requires reauthorization by the user who authorized its Spaces access"));
    }
    if (current.state === "revoked") return fail(err.conflict("This automation's Spaces authorization is revoked"));
    return current.state === "active" ? ok(current) : mandates.resume({ mandateId, expectedRevision: current.revision, authority }, { db });
  }
  return current.state === "paused" || current.state === "revoked"
    ? ok(current)
    : mandates.pause({ mandateId, expectedRevision: current.revision, authority: mandateWorkloadAuthority }, { db });
};

const toIso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();
const normalizeName = (value: string): string => value.trim().replace(/\s+/gu, " ");
const parseJson = <T>(value: T | string): T => (typeof value === "string" ? (JSON.parse(value) as T) : value);
const internalWorkflowName = (id: string): string => `Mail incoming automation ${id}`;
const EXISTING_MESSAGE_APPLICATION_LIMIT = 100;
const MAX_INCOMING_AUTOMATIONS = 500;
const activeIncomingAutomationBackfillStates = new Set(["queued", "running", "waiting"]);
const isSameOrSubdomain = (candidate: string, domain: string): boolean => candidate === domain || candidate.endsWith(`.${domain}`);
const incomingAutomationExistingDedupePrefix = (automationId: string, workflowVersionId: string): string =>
  `incoming-automation-existing:${automationId}:v${workflowVersionId}:`;
export const incomingAutomationExistingDedupeKey = (automationId: string, workflowVersionId: string, targetKey: string): string =>
  `${incomingAutomationExistingDedupePrefix(automationId, workflowVersionId)}${targetKey}`;

type IncomingAutomationBackfillInput = {
  operationId: string;
  mailboxId: string;
  automationId: string;
  workflowId: string;
  workflowVersionId: string;
  scope: MailAutomationScope;
  cutoffAt: string;
};

type IncomingAutomationBackfillCursor = {
  internalDate: string;
  remoteMessageRefId: string;
};

type IncomingAutomationBackfillItem = {
  key: string;
  remoteMessageRefId: string;
};

const incomingAutomationBackfillKey = (automationId: string, operationId: string): string => `${automationId}:${operationId}`;

const requestActor = (context: MailRequestContext): AutomationActor => {
  const actor = actorRefFromRequest(context);
  if (actor.kind === "user") return { kind: actor.kind, id: actor.userId };
  if (actor.kind === "service_account") return { kind: actor.kind, id: actor.serviceAccountId };
  throw new TypeError("Request actor cannot configure incoming automations");
};

const mapIncomingAutomation = (row: IncomingAutomationRow): StoredIncomingAutomation =>
  Object.defineProperties(
    {
      id: row.id,
      mailboxId: row.mailbox_id,
      workflowId: row.workflow_id,
      workflowVersionId: row.workflow_version_id,
      name: row.name,
      enabled: row.enabled,
      scope: parseJson(row.scope),
      steps: parseJson(row.steps),
      latestBackfillOperationId: row.latest_backfill_operation_id,
      workflowSource: row.workflow_source,
      revision: Number(row.revision),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    } as StoredIncomingAutomation,
    {
      mandateId: { value: row.mandate_id, enumerable: false },
    },
  );

const normalizeSenderMatch = (kind: SenderMatchKind, value: string): Result<string> => {
  const normalized = kind === "sender" ? normalizeEmailAddress(value) : normalizeEmailDomain(value);
  if (!normalized) return fail(err.badInput(kind === "sender" ? "Enter a valid sender email address" : "Enter a valid sender domain"));
  if (kind === "domain" && !normalized.includes(".")) {
    return fail(err.badInput("Enter a complete sender domain, for example example.com"));
  }
  return ok(normalized);
};

const senderMatchSql = (kind: SenderMatchKind, value: string) =>
  kind === "sender" ? sql`sender.normalized_email = ${value}` : sql`split_part(sender.normalized_email, '@', 2) = ${value}`;
type SqlFragment = ReturnType<typeof senderMatchSql>;

export const normalizeMailAutomationConditions = (conditions: MailAutomationConditions): Result<MailAutomationConditions> => {
  const items: MailAutomationCondition[] = [];
  for (const condition of conditions.items) {
    if (condition.field !== "sender_address" && condition.field !== "sender_domain") {
      items.push(condition);
      continue;
    }
    const kind = condition.field === "sender_address" ? "sender" : "domain";
    const normalized = normalizeSenderMatch(kind, condition.value);
    if (!normalized.ok) return normalized;
    items.push({ ...condition, value: normalized.data });
  }
  return ok({ mode: conditions.mode, items });
};

const senderCondition = (condition: MailAutomationCondition): { kind: SenderMatchKind; value: string } | null =>
  condition.field === "sender_address"
    ? { kind: "sender", value: condition.value }
    : condition.field === "sender_domain"
      ? { kind: "domain", value: condition.value }
      : null;

const combineSql = (parts: SqlFragment[], operator: "AND" | "OR"): SqlFragment => {
  const first = parts[0];
  if (!first) return sql`TRUE`;
  return parts
    .slice(1)
    .reduce((combined, part) => (operator === "AND" ? sql`(${combined} AND ${part})` : sql`(${combined} OR ${part})`), first);
};

const scopeConditions = (scope: MailAutomationScope): AutomationConditionSet =>
  scope.mode === "matching" ? scope.conditions : { mode: "all", items: [] };

const normalizeAutomationScope = (scope: MailAutomationScope): Result<MailAutomationScope> => {
  if (scope.mode === "all") return ok(scope);
  const conditions = normalizeMailAutomationConditions(scope.conditions);
  return conditions.ok ? ok({ mode: "matching", conditions: conditions.data }) : conditions;
};

const incomingAutomationCandidateSql = (scope: MailAutomationScope) => {
  const conditions = scopeConditions(scope);
  const senderConditions = conditions.items.flatMap((condition) => {
    const sender = senderCondition(condition);
    return sender ? [senderMatchSql(sender.kind, sender.value)] : [];
  });
  if (conditions.mode === "all") return combineSql(senderConditions, "AND");
  return senderConditions.length === conditions.items.length ? combineSql(senderConditions, "OR") : sql`TRUE`;
};

const incomingAutomationPreviewIsExact = (scope: MailAutomationScope): boolean =>
  scope.mode === "all" ||
  scope.conditions.items.every((condition) => condition.field === "sender_address" || condition.field === "sender_domain");

const incomingAutomationTargetFrom = sql`
  FROM mail.remote_message_refs remote_ref
  JOIN mail.message_placements placement
    ON placement.remote_message_ref_id = remote_ref.id
   AND placement.deleted_at IS NULL
  JOIN mail.folders folder
    ON folder.id = placement.folder_id
   AND folder.discovery_state = 'active'
  JOIN mail.remote_resources resource
    ON resource.id = folder.remote_resource_id
  JOIN mail.message_contents message
    ON message.id = remote_ref.message_id
  JOIN mail.message_addresses sender
    ON sender.message_id = message.id
   AND sender.role = 'from'
  LEFT JOIN mail.conversation_messages conversation_message
    ON conversation_message.message_id = message.id
`;

const inboundIncomingAutomationTarget = sql`
  NOT EXISTS (
    SELECT 1
    FROM mail.sender_identities identity
    WHERE identity.mailbox_id = resource.mailbox_id
      AND lower(identity.from_address) = sender.normalized_email
      AND identity.status <> 'disabled'
  )
`;

const normalizePreviewScope = (input: PreviewIncomingAutomationMatchesInput): Result<MailAutomationScope> => {
  const parsed = previewIncomingAutomationMatchesInputSchema.safeParse(input);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid automation scope"));
  return normalizeAutomationScope(parsed.data.scope);
};

const rejectOwnSenderTargets = async (params: {
  mailboxId: string;
  conditions: AutomationConditionSet;
  db: SqlClient;
}): Promise<Result<void>> => {
  const addresses = params.conditions.items.flatMap((condition) => (condition.field === "sender_address" ? [condition.value] : []));
  if (addresses.length === 0) return ok();
  const [identity] = await params.db<{ id: string }[]>`
    SELECT id
    FROM mail.sender_identities
    WHERE mailbox_id = ${params.mailboxId}::uuid
      AND lower(from_address) = ANY(${toPgTextArray(addresses)}::text[])
      AND status <> 'disabled'
    LIMIT 1
  `;
  return identity ? fail(err.badInput("Incoming automations apply only to incoming mail; remove the mailbox's own sender address")) : ok();
};

const protectMailboxSenders = async (params: {
  mailboxId: string;
  conditions: AutomationConditionSet;
  actions: MailAutomationAction[];
  db: SqlClient;
}): Promise<Result<void>> => {
  const genericMoves = params.actions.filter(
    (action): action is Extract<MailAutomationAction, { kind: "move_to_folder" }> => action.kind === "move_to_folder",
  );
  if (genericMoves.length > 0) {
    const folderIds = [...new Set(genericMoves.map((action) => action.folderId))];
    const folders = await params.db<{ id: string; role: string | null }[]>`
      SELECT folder.id, COALESCE(role_override.role, folder.role) AS role
      FROM mail.folders folder
      JOIN mail.remote_resources resource ON resource.id = folder.remote_resource_id
      LEFT JOIN mail.folder_role_overrides role_override
        ON role_override.mailbox_id = resource.mailbox_id AND role_override.folder_id = folder.id
      WHERE resource.mailbox_id = ${params.mailboxId}::uuid
        AND folder.id = ANY(${toPgUuidArray(folderIds)}::uuid[])
        AND folder.discovery_state = 'active'
        AND folder.selectable
    `;
    const folderRoles = new Map(folders.map((folder) => [folder.id, folder.role]));
    for (const folderId of folderIds) {
      const role = folderRoles.get(folderId);
      if (role === undefined) return fail(err.badInput("Choose an available destination folder"));
      if (role === "junk" || role === "trash") {
        return fail(err.badInput(`Use the dedicated move-to-${role} action for protected sender checks`));
      }
    }
  }
  const destructive = destructiveActionFrom(params.actions);
  if (!destructive) return ok();
  const [mailbox] = await params.db<{ compose_safety: { internalDomains?: unknown } | string }[]>`
    SELECT compose_safety
    FROM mail.mailboxes
    WHERE id = ${params.mailboxId}::uuid AND deleted_at IS NULL
  `;
  const identities = await params.db<{ from_address: string }[]>`
    SELECT from_address
    FROM mail.sender_identities
    WHERE mailbox_id = ${params.mailboxId}::uuid
  `;
  const composeSafety = mailbox ? parseJson(mailbox.compose_safety) : {};
  const internalDomains = new Set(
    (Array.isArray(composeSafety.internalDomains) ? composeSafety.internalDomains : [])
      .flatMap((value) => (typeof value === "string" ? [normalizeEmailDomain(value)] : []))
      .filter((value): value is string => Boolean(value)),
  );
  const identityAddresses = new Set(
    identities.map((identity) => normalizeEmailAddress(identity.from_address)).filter((value): value is string => Boolean(value)),
  );
  const identityDomains = new Set(
    [...identityAddresses]
      .map((address) => normalizeEmailDomain(address.slice(address.lastIndexOf("@") + 1)))
      .filter((value): value is string => Boolean(value)),
  );
  const protectedScope = (scope: { kind: SenderMatchKind; value: string }): boolean =>
    scope.kind === "sender"
      ? identityAddresses.has(scope.value) ||
        [...internalDomains].some((domain) => isSameOrSubdomain(scope.value.slice(scope.value.lastIndexOf("@") + 1), domain))
      : [...identityDomains, ...internalDomains].some(
          (domain) => isSameOrSubdomain(scope.value, domain) || isSameOrSubdomain(domain, scope.value),
        );
  const scopes = params.conditions.items.flatMap((condition) => {
    const scope = senderCondition(condition);
    return scope ? [scope] : [];
  });
  const safelyScoped =
    params.conditions.mode === "all"
      ? scopes.some((scope) => !protectedScope(scope))
      : scopes.length === params.conditions.items.length && scopes.every((scope) => !protectedScope(scope));
  return safelyScoped
    ? ok()
    : fail(err.badInput("Automations that move mail to junk or trash must restrict every possible match to an external sender or domain"));
};

const destructiveAction = (action: MailAutomationAction): action is Extract<MailAutomationAction, { kind: "junk" | "trash" }> =>
  action.kind === "junk" || action.kind === "trash";

const destructiveActionFrom = (actions: MailAutomationAction[]): Extract<MailAutomationAction, { kind: "junk" | "trash" }> | undefined =>
  actions.find(destructiveAction);

const destructiveKindsFrom = (actions: MailAutomationAction[]): Set<"junk" | "trash"> =>
  new Set(actions.flatMap((action) => (destructiveAction(action) ? [action.kind] : [])));

const senderScopesOverlap = (left: { kind: SenderMatchKind; value: string }, right: { kind: SenderMatchKind; value: string }): boolean => {
  if (left.kind === "sender" && right.kind === "sender") return left.value === right.value;
  if (left.kind === "domain" && right.kind === "domain") {
    return isSameOrSubdomain(left.value, right.value) || isSameOrSubdomain(right.value, left.value);
  }
  const sender = left.kind === "sender" ? left.value : right.value;
  const domain = left.kind === "domain" ? left.value : right.value;
  return isSameOrSubdomain(sender.slice(sender.lastIndexOf("@") + 1), domain);
};

const constrainingSenderScopes = (conditions: AutomationConditionSet): Array<{ kind: SenderMatchKind; value: string }> | null => {
  const scopes = conditions.items.flatMap((condition) => {
    const scope = senderCondition(condition);
    return scope ? [scope] : [];
  });
  if (conditions.mode === "any") return scopes.length === conditions.items.length ? scopes : null;
  return scopes.length > 0 ? [scopes[0]!] : null;
};

const conditionsPotentiallyOverlap = (left: AutomationConditionSet, right: AutomationConditionSet): boolean => {
  if (JSON.stringify(left) === JSON.stringify(right)) return true;
  const leftScopes = constrainingSenderScopes(left);
  const rightScopes = constrainingSenderScopes(right);
  return (
    !leftScopes ||
    !rightScopes ||
    leftScopes.some((leftScope) => rightScopes.some((rightScope) => senderScopesOverlap(leftScope, rightScope)))
  );
};

const protectAgainstConflictingAutomations = async (params: {
  mailboxId: string;
  automationId?: string;
  enabled: boolean;
  conditions: AutomationConditionSet;
  actions: MailAutomationAction[];
  db: SqlClient;
}): Promise<Result<void>> => {
  const destructiveKinds = destructiveKindsFrom(params.actions);
  if (!params.enabled || destructiveKinds.size === 0) return ok();
  const rows = await params.db<
    Array<{
      id: string;
      name: string;
      scope: MailAutomationScope | string;
      steps: MailAutomationStep[] | string;
    }>
  >`
    SELECT automation.id, automation.name, automation.scope, automation.steps
    FROM mail.incoming_automations automation
    WHERE automation.mailbox_id = ${params.mailboxId}::uuid
      AND automation.deleted_at IS NULL
      AND automation.enabled = true
      AND (${params.automationId ?? null}::uuid IS NULL OR automation.id <> ${params.automationId ?? null}::uuid)
    FOR UPDATE
  `;
  const conflict = rows.find((row) => {
    const existingKinds = destructiveKindsFrom(incomingAutomationActions(parseJson<MailAutomationStep[]>(row.steps)));
    const incompatible = [...existingKinds].some((existing) => [...destructiveKinds].some((candidate) => existing !== candidate));
    return incompatible && conditionsPotentiallyOverlap(params.conditions, scopeConditions(parseJson(row.scope)));
  });
  return conflict ? fail(err.conflict(`Incoming automation conflicts with “${conflict.name}”`)) : ok();
};

export const validateDestructiveIncomingAutomationsForMailbox = async (params: {
  mailboxId: string;
  internalDomains?: readonly string[];
  identityAddresses?: readonly string[];
  db: SqlClient;
}): Promise<Result<void>> => {
  const [mailbox] = await params.db<{ compose_safety: { internalDomains?: unknown } | string }[]>`
    SELECT compose_safety FROM mail.mailboxes WHERE id = ${params.mailboxId}::uuid AND deleted_at IS NULL
  `;
  if (!mailbox) return fail(err.notFound("Mailbox"));
  const identityRows =
    params.identityAddresses === undefined
      ? await params.db<{ from_address: string }[]>`
          SELECT from_address FROM mail.sender_identities
          WHERE mailbox_id = ${params.mailboxId}::uuid AND status <> 'disabled'
        `
      : params.identityAddresses.map((from_address) => ({ from_address }));
  const configuredSafety = parseJson(mailbox.compose_safety);
  const internalDomains = new Set(
    (params.internalDomains ?? (Array.isArray(configuredSafety.internalDomains) ? configuredSafety.internalDomains : []))
      .flatMap((value) => (typeof value === "string" ? [normalizeEmailDomain(value)] : []))
      .filter((value): value is string => Boolean(value)),
  );
  const identityAddresses = new Set(
    identityRows.map((identity) => normalizeEmailAddress(identity.from_address)).filter((value): value is string => Boolean(value)),
  );
  const identityDomains = new Set(
    [...identityAddresses]
      .map((address) => normalizeEmailDomain(address.slice(address.lastIndexOf("@") + 1)))
      .filter((value): value is string => Boolean(value)),
  );
  const automations = await params.db<
    Array<{ id: string; name: string; scope: MailAutomationScope | string; steps: MailAutomationStep[] | string }>
  >`
    SELECT automation.id, automation.name, automation.scope, automation.steps
    FROM mail.incoming_automations automation
    WHERE automation.mailbox_id = ${params.mailboxId}::uuid
      AND automation.deleted_at IS NULL
      AND automation.enabled = true
    FOR UPDATE
  `;
  const unsafe = automations.find((automation) => {
    const actions = incomingAutomationActions(parseJson<MailAutomationStep[]>(automation.steps));
    if (!actions.some((action) => action.kind === "junk" || action.kind === "trash")) return false;
    const conditions = scopeConditions(parseJson<MailAutomationScope>(automation.scope));
    const protectedScope = (scope: { kind: SenderMatchKind; value: string }): boolean =>
      scope.kind === "sender"
        ? identityAddresses.has(scope.value) ||
          [...internalDomains].some((domain) => isSameOrSubdomain(scope.value.slice(scope.value.lastIndexOf("@") + 1), domain))
        : [...identityDomains, ...internalDomains].some(
            (domain) => isSameOrSubdomain(scope.value, domain) || isSameOrSubdomain(domain, scope.value),
          );
    const scopes = conditions.items.flatMap((condition) => {
      const scope = senderCondition(condition);
      return scope ? [scope] : [];
    });
    return conditions.mode === "all"
      ? !scopes.some((scope) => !protectedScope(scope))
      : scopes.length !== conditions.items.length || scopes.some(protectedScope);
  });
  return unsafe ? fail(err.conflict(`Incoming automation “${unsafe.name}” must be changed before updating mailbox sender safety`)) : ok();
};

const lockMailbox = async (context: MailRequestContext, mailboxId: string, db: SqlClient): Promise<Result<void>> => {
  const [mailbox] = await db<{ id: string }[]>`
    SELECT id
    FROM mail.mailboxes
    WHERE id = ${mailboxId}::uuid AND deleted_at IS NULL
    FOR UPDATE
  `;
  if (!mailbox) return fail(err.notFound("Mailbox"));
  const allowed = await requireMailboxPermission(context, mailboxId, "admin", db);
  return allowed.ok ? ok() : allowed;
};

const loadIncomingAutomation = async (
  mailboxId: string,
  automationId: string,
  db: SqlClient,
  lock = false,
  includeDeleted = false,
): Promise<Result<StoredIncomingAutomation>> => {
  const [row] = await db<IncomingAutomationRow[]>`
    SELECT ${incomingAutomationColumns}
    FROM mail.incoming_automations automation
    WHERE automation.id = ${automationId}::uuid
      AND automation.mailbox_id = ${mailboxId}::uuid
      AND ${includeDeleted ? sql`TRUE` : sql`automation.deleted_at IS NULL`}
    ${lock ? sql`FOR UPDATE OF automation` : sql``}
  `;
  return row ? ok(mapIncomingAutomation(row)) : fail(err.notFound("Incoming automation"));
};

export const getIncomingAutomationCatalog = async (
  context: MailRequestContext,
  mailboxId: string,
): Promise<Result<MailWorkflowCatalogSnapshot>> => {
  const allowed = await requireMailboxPermission(context, mailboxId, "admin");
  if (!allowed.ok) return allowed;
  return ok(snapshotMailWorkflowCatalog(await loadMailWorkflowCatalog({ context, mailboxId })));
};

const recordActivity = async (params: {
  db: SqlClient;
  context: MailRequestContext;
  automation: IncomingAutomation;
  action: "incoming_automation.created" | "incoming_automation.updated" | "incoming_automation.deleted";
}): Promise<string> => {
  const actor = requestActor(params.context);
  const [activity] = await params.db<{ id: string | number }[]>`
    INSERT INTO mail.activity_events (
      mailbox_id, actor_kind, actor_id, action, outcome, target_type, target_id, metadata
    ) VALUES (
      ${params.automation.mailboxId}::uuid,
      ${actor.kind},
      ${actor.id}::uuid,
      ${params.action},
      'confirmed',
      'incoming_automation',
      ${params.automation.id}::uuid,
      ${{
        workflowId: params.automation.workflowId,
        enabled: params.automation.enabled,
        scope: params.automation.scope,
        ai: incomingAutomationHasAi(params.automation.steps),
        revision: params.automation.revision,
      }}::jsonb
    )
    RETURNING id
  `;
  if (!activity) throw new Error("Incoming automation activity insert returned no row");
  return String(activity.id);
};

const publishAutomationChange = async (automation: IncomingAutomation, activityId: string): Promise<void> =>
  publishMailMailboxEvent({
    mailboxId: automation.mailboxId,
    conversationId: null,
    reason: "incoming_automation",
    targetId: automation.id,
    activityId,
  });

const mutationFailure = (error: unknown, fallback: string): Result<never> => {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    if (isServiceError(current)) return fail(current);
    current = (current as { cause?: unknown }).cause;
  }
  if (databaseErrorCode(error) === "23505") return fail(err.conflict("Incoming automation name already exists"));
  return fail(err.internal(fallback));
};

export const listIncomingAutomations = async (context: MailRequestContext, mailboxId: string): Promise<Result<IncomingAutomation[]>> => {
  const allowed = await requireMailboxPermission(context, mailboxId, "read");
  if (!allowed.ok) return allowed;
  const rows = await sql<IncomingAutomationRow[]>`
    SELECT ${incomingAutomationColumns}
    FROM mail.incoming_automations automation
    WHERE automation.mailbox_id = ${mailboxId}::uuid
      AND automation.deleted_at IS NULL
    ORDER BY automation.enabled DESC, automation.normalized_name, automation.id
    LIMIT 500
  `;
  return ok(rows.map(mapIncomingAutomation));
};

export const listIncomingAutomationActivityMetadata = async (
  context: MailRequestContext,
  mailboxId: string,
  workflowIds: readonly string[],
): Promise<Result<IncomingAutomationActivityMetadata[]>> => {
  const allowed = await requireMailboxPermission(context, mailboxId, "read");
  if (!allowed.ok) return allowed;
  if (workflowIds.length === 0) return ok([]);
  const rows = await sql<{ id: string; workflow_id: string; name: string }[]>`
    SELECT id, workflow_id, name
    FROM mail.incoming_automations
    WHERE mailbox_id = ${mailboxId}::uuid
      AND workflow_id = ANY(${toPgUuidArray([...new Set(workflowIds)])}::uuid[])
  `;
  return ok(rows.map((row) => ({ id: row.id, workflowId: row.workflow_id, name: row.name })));
};

export const getIncomingAutomation = async (
  context: MailRequestContext,
  mailboxId: string,
  automationId: string,
): Promise<Result<IncomingAutomation>> => {
  const allowed = await requireMailboxPermission(context, mailboxId, "read");
  if (!allowed.ok) return allowed;
  return loadIncomingAutomation(mailboxId, automationId, sql);
};

export const previewIncomingAutomationMatches = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  input: PreviewIncomingAutomationMatchesInput;
}): Promise<Result<IncomingAutomationMatchPreview>> => {
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "read");
  if (!allowed.ok) return allowed;
  const scope = normalizePreviewScope(params.input);
  if (!scope.ok) return scope;
  const incoming = await rejectOwnSenderTargets({
    mailboxId: params.mailboxId,
    conditions: scopeConditions(scope.data),
    db: sql,
  });
  if (!incoming.ok) return incoming;
  const [counts] = await sql<{ message_count: string | number; conversation_count: string | number }[]>`
    SELECT
      COUNT(DISTINCT remote_ref.id)::int AS message_count,
      COUNT(DISTINCT conversation_message.conversation_id)::int AS conversation_count
    ${incomingAutomationTargetFrom}
    WHERE resource.mailbox_id = ${params.mailboxId}::uuid
      AND remote_ref.stale_at IS NULL
      AND ${inboundIncomingAutomationTarget}
      AND ${incomingAutomationCandidateSql(scope.data)}
  `;
  const messageCount = Number(counts?.message_count ?? 0);
  return ok({
    messageCount,
    conversationCount: Number(counts?.conversation_count ?? 0),
    applicationLimit: EXISTING_MESSAGE_APPLICATION_LIMIT,
    capped: messageCount > EXISTING_MESSAGE_APPLICATION_LIMIT,
    exact: incomingAutomationPreviewIsExact(scope.data),
  });
};

const loadCurrentBackfillAutomation = async (
  input: IncomingAutomationBackfillInput,
  db: SqlClient,
  lock = false,
): Promise<IncomingAutomation> => {
  const automation = unwrap(await loadIncomingAutomation(input.mailboxId, input.automationId, db, lock));
  if (!automation.enabled) throw new Error("Mail automation is disabled");
  if (automation.latestBackfillOperationId !== input.operationId) throw new Error("Mail automation backfill is not active");
  if (automation.workflowId !== input.workflowId || automation.workflowVersionId !== input.workflowVersionId) {
    throw new Error("Mail automation workflow version changed");
  }
  return automation;
};

const backfillMutationMutex = lazySync((sync) =>
  sync.mutex({ id: "mail:incoming-automation-start", ttlMs: 30_000, retry: { maxAttempts: 1 } }),
);

const BACKFILL_PUMP_ID = "mail:incoming-automation-backfill";
const getIncomingAutomationBackfillPump = lazySync((sync) =>
  sync.pump<IncomingAutomationBackfillInput, IncomingAutomationBackfillCursor, IncomingAutomationBackfillItem>({
    id: BACKFILL_PUMP_ID,
    batchSize: 100,
    retry: { maxAttempts: 3, backoffMs: [1_000, 2_000, 4_000] },
    pull: async ({ input, cursor, limit }) => {
      await loadCurrentBackfillAutomation(input, sql);
      const afterCursor = cursor
        ? sql`
            AND (
              message.internal_date < ${cursor.internalDate}
              OR (message.internal_date = ${cursor.internalDate} AND remote_ref.id < ${cursor.remoteMessageRefId}::uuid)
            )
          `
        : sql``;
      const rows = await sql<{ remote_message_ref_id: string; internal_date: Date | string }[]>`
        SELECT DISTINCT remote_ref.id AS remote_message_ref_id, message.internal_date
        ${incomingAutomationTargetFrom}
        WHERE resource.mailbox_id = ${input.mailboxId}::uuid
          AND remote_ref.stale_at IS NULL
          AND remote_ref.first_seen_at <= ${input.cutoffAt}
          AND ${inboundIncomingAutomationTarget}
          AND ${incomingAutomationCandidateSql(input.scope)}
          AND NOT EXISTS (
            SELECT 1
            FROM workflows.event existing_event
            WHERE existing_event.app_id = ${MAIL_WORKFLOW_APP_ID}
              AND existing_event.scope_id = ${input.mailboxId}
              AND existing_event.type = ${MAIL_WORKFLOW_EVENT.messageReceived}
              AND existing_event.dedupe_key =
                ${incomingAutomationExistingDedupePrefix(input.automationId, input.workflowVersionId)} || remote_ref.id::text
          )
          ${afterCursor}
        ORDER BY message.internal_date DESC, remote_ref.id DESC
        LIMIT ${limit}
      `;
      const last = rows.at(-1);
      return {
        items: rows.map((row) => ({ key: row.remote_message_ref_id, remoteMessageRefId: row.remote_message_ref_id })),
        nextCursor:
          rows.length === limit && last
            ? {
                internalDate: toIso(last.internal_date),
                remoteMessageRefId: last.remote_message_ref_id,
              }
            : null,
      };
    },
    dispatch: async ({ input, item }) => {
      await sql.begin(async (tx) => {
        const automation = await loadCurrentBackfillAutomation(input, tx, true);
        const snapshot = await getWorkflowSnapshot({
          mailboxId: input.mailboxId,
          remoteMessageRefId: item.remoteMessageRefId,
          db: tx,
        });
        if (!snapshot) return;
        await emitWorkflowEvent(
          {
            appId: MAIL_WORKFLOW_APP_ID,
            scopeId: input.mailboxId,
            type: MAIL_WORKFLOW_EVENT.messageReceived,
            targetWorkflowId: automation.workflowId,
            data: {
              message: snapshot.source.message as unknown as WorkflowJsonValue,
              conversation: snapshot.source.conversation as unknown as WorkflowJsonValue,
            },
            context: mailWorkflowEventContext(snapshot),
            dedupeKey: incomingAutomationExistingDedupeKey(automation.id, automation.workflowVersionId, snapshot.targetKey),
            occurredAt: new Date(snapshot.internalDate),
          },
          { db: tx },
        );
      });
    },
  }),
);

let backfillWorker: Worker | undefined;
export const startIncomingAutomationBackfillRuntime = async (): Promise<void> => {
  backfillWorker = await getIncomingAutomationBackfillPump().process();
};

export const stopIncomingAutomationBackfillRuntime = async (): Promise<void> => {
  await backfillWorker?.drain();
  backfillWorker = undefined;
};

const loadIncomingAutomationBackfillCounts = async (
  input: IncomingAutomationBackfillInput,
): Promise<{ candidates: number; accepted: number }> => {
  const [row] = await sql<{ candidates: string | number; accepted: string | number }[]>`
    SELECT
      COUNT(DISTINCT remote_ref.id)::bigint AS candidates,
      COUNT(DISTINCT remote_ref.id) FILTER (
        WHERE EXISTS (
          SELECT 1
          FROM workflows.event existing_event
          WHERE existing_event.app_id = ${MAIL_WORKFLOW_APP_ID}
            AND existing_event.scope_id = ${input.mailboxId}
            AND existing_event.type = ${MAIL_WORKFLOW_EVENT.messageReceived}
            AND existing_event.dedupe_key =
              ${incomingAutomationExistingDedupePrefix(input.automationId, input.workflowVersionId)} || remote_ref.id::text
        )
      )::bigint AS accepted
    ${incomingAutomationTargetFrom}
    WHERE resource.mailbox_id = ${input.mailboxId}::uuid
      AND remote_ref.stale_at IS NULL
      AND remote_ref.first_seen_at <= ${input.cutoffAt}
      AND ${inboundIncomingAutomationTarget}
      AND ${incomingAutomationCandidateSql(input.scope)}
  `;
  return { candidates: Number(row?.candidates ?? 0), accepted: Number(row?.accepted ?? 0) };
};

const mapIncomingAutomationBackfill = async (
  state: PumpState<IncomingAutomationBackfillInput, IncomingAutomationBackfillCursor>,
): Promise<IncomingAutomationBackfill> => {
  const counts = await loadIncomingAutomationBackfillCounts(state.input);
  const newlyAcceptedCount = Math.min(state.dispatched, counts.accepted);
  return {
    operationId: state.input.operationId,
    automationId: state.input.automationId,
    workflowVersionId: state.input.workflowVersionId,
    state: state.status,
    candidateCount: counts.candidates,
    alreadyAcceptedCount: Math.max(0, counts.accepted - newlyAcceptedCount),
    newlyAcceptedCount,
    remainingCount: Math.max(0, counts.candidates - counts.accepted),
    failureCount: state.failureCount,
    lastError: state.lastError ?? null,
    createdAt: new Date(state.createdAt).toISOString(),
    updatedAt: new Date(state.updatedAt).toISOString(),
  };
};

const loadIncomingAutomationBackfill = async (params: {
  mailboxId: string;
  automationId: string;
  operationId: string;
}): Promise<Result<IncomingAutomationBackfill>> => {
  const state = await getIncomingAutomationBackfillPump().get({
    key: incomingAutomationBackfillKey(params.automationId, params.operationId),
  });
  if (
    !state ||
    state.input.mailboxId !== params.mailboxId ||
    state.input.automationId !== params.automationId ||
    state.input.operationId !== params.operationId
  ) {
    return fail(err.notFound("Mail automation backfill"));
  }
  return ok(await mapIncomingAutomationBackfill(state));
};

const incomingAutomationHasActiveBackfill = async (automation: IncomingAutomation): Promise<boolean> => {
  if (!automation.latestBackfillOperationId) return false;
  const state = await getIncomingAutomationBackfillPump().get({
    key: incomingAutomationBackfillKey(automation.id, automation.latestBackfillOperationId),
  });
  return Boolean(state && activeIncomingAutomationBackfillStates.has(state.status));
};

const rejectActiveBackfillMutation = async (automation: IncomingAutomation, allowedOperationId?: string): Promise<Result<void>> =>
  automation.latestBackfillOperationId !== allowedOperationId && (await incomingAutomationHasActiveBackfill(automation))
    ? fail(err.conflict("Cancel the active backfill before changing this automation"))
    : ok();

export const startIncomingAutomationBackfill = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  automationId: string;
  input: StartIncomingAutomationBackfillInput;
}): Promise<Result<IncomingAutomationBackfill>> => {
  const parsed = startIncomingAutomationBackfillInputSchema.safeParse(params.input);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid mail automation backfill"));
  try {
    const mutex = backfillMutationMutex();
    const lock = await mutex.acquire({ resource: params.automationId });
    if (!lock) return fail(err.conflict("Mail automation backfill is being started; retry shortly"));
    try {
      return await withLeaseHeartbeat({
        intervalMs: 10_000,
        heartbeat: async () => {
          if (!(await mutex.extend(lock, { ttlMs: 30_000 }))) throw new Error("Mail automation start lease was lost");
        },
        work: async (assertLeaseActive) => {
          const automation = await sql.begin(async (tx) => {
            unwrap(await requireMailboxPermission(params.context, params.mailboxId, "admin", tx));
            const current = unwrap(await loadIncomingAutomation(params.mailboxId, params.automationId, tx, true));
            if (current.revision !== parsed.data.expectedRevision) unwrap(fail(err.conflict("Mail automation was changed")));
            if (!current.enabled) unwrap(fail(err.badInput("Enable the mail automation before applying it to existing messages")));
            if (incomingAutomationHasAi(current.steps)) {
              unwrap(fail(err.badInput("Flows with AI run only for future incoming mail")));
            }
            unwrap(await rejectActiveBackfillMutation(current, parsed.data.operationId));
            unwrap(
              await protectMailboxSenders({
                mailboxId: params.mailboxId,
                conditions: scopeConditions(current.scope),
                actions: incomingAutomationActions(current.steps),
                db: tx,
              }),
            );
            return current;
          });
          const pump = getIncomingAutomationBackfillPump();
          const key = incomingAutomationBackfillKey(automation.id, parsed.data.operationId);
          const existing = await pump.get({ key });
          if (
            existing &&
            (existing.input.mailboxId !== params.mailboxId ||
              existing.input.automationId !== automation.id ||
              existing.input.operationId !== parsed.data.operationId ||
              existing.input.workflowVersionId !== automation.workflowVersionId)
          ) {
            return fail(err.conflict("Backfill operation id is already in use"));
          }
          await assertLeaseActive();
          const [associated] = await sql<{ id: string }[]>`
      UPDATE mail.incoming_automations
      SET latest_backfill_operation_id = ${parsed.data.operationId}::uuid
      WHERE mailbox_id = ${params.mailboxId}::uuid
        AND id = ${automation.id}::uuid
        AND deleted_at IS NULL
        AND enabled = true
        AND revision = ${automation.revision}
        AND latest_backfill_operation_id IS NOT DISTINCT FROM ${automation.latestBackfillOperationId}::uuid
        AND (
          SELECT workflow.active_version_id
          FROM workflows.workflow workflow
          WHERE workflow.id = mail.incoming_automations.workflow_id
        ) = ${automation.workflowVersionId}::uuid
      RETURNING id
    `;
          if (!associated) {
            return fail(err.conflict("Mail automation changed before the backfill started"));
          }
          if (!existing) {
            await trace.start({
              name: "Mail automation backfill",
              source: BACKFILL_PUMP_ID,
              appId: "mail",
              category: "backfill",
              spanKey: trace.syncSpanKey("pump", BACKFILL_PUMP_ID, key),
              attributes: {
                "mail.mailbox.id": params.mailboxId,
                "mail.incoming_automation.id": automation.id,
                "mail.workflow.id": automation.workflowId,
                "mail.workflow.version_id": automation.workflowVersionId,
                "mail.backfill.operation_id": parsed.data.operationId,
              },
            });
            await assertLeaseActive();
            await pump.start({
              key: incomingAutomationBackfillKey(automation.id, parsed.data.operationId),
              input: {
                operationId: parsed.data.operationId,
                mailboxId: params.mailboxId,
                automationId: automation.id,
                workflowId: automation.workflowId,
                workflowVersionId: automation.workflowVersionId,
                scope: automation.scope,
                cutoffAt: new Date().toISOString(),
              },
            });
          }
          const state = existing ?? (await pump.get({ key }));
          if (!state) throw new Error("Mail automation backfill was not persisted");
          const result = ok(await mapIncomingAutomationBackfill(state));
          return audit.recordResultAfterSideEffect({
            action: "mail.incoming_automation.backfill.start",
            actor: auditActorFromRequest(params.context),
            target: { type: "incoming_automation", id: automation.id, label: automation.name },
            requestId: params.context.requestId,
            metadata: {
              mailboxId: params.mailboxId,
              workflowId: automation.workflowId,
              workflowVersionId: automation.workflowVersionId,
              operationId: parsed.data.operationId,
            },
            result,
          });
        },
      });
    } finally {
      await mutex.release(lock);
    }
  } catch (error) {
    return mutationFailure(error, "Failed to start mail automation backfill");
  }
};

export const getIncomingAutomationBackfill = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  automationId: string;
  operationId: string;
}): Promise<Result<IncomingAutomationBackfill>> => {
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "admin");
  if (!allowed.ok) return allowed;
  try {
    return await loadIncomingAutomationBackfill(params);
  } catch {
    return fail(err.internal("Failed to load mail automation backfill"));
  }
};

export const cancelIncomingAutomationBackfill = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  automationId: string;
  operationId: string;
}): Promise<Result<IncomingAutomationBackfill>> => {
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "admin");
  if (!allowed.ok) return allowed;
  try {
    const current = await loadIncomingAutomationBackfill(params);
    if (!current.ok) return current;
    if (!["queued", "running", "waiting"].includes(current.data.state)) return current;
    const canceled = await getIncomingAutomationBackfillPump().cancel({
      key: incomingAutomationBackfillKey(params.automationId, params.operationId),
    });
    const result = await loadIncomingAutomationBackfill(params);
    if (!result.ok) return result;
    if (!canceled) return result;
    return audit.recordResultAfterSideEffect({
      action: "mail.incoming_automation.backfill.cancel",
      actor: auditActorFromRequest(params.context),
      target: { type: "incoming_automation", id: params.automationId },
      requestId: params.context.requestId,
      metadata: { mailboxId: params.mailboxId, operationId: params.operationId },
      result,
    });
  } catch {
    return fail(err.internal("Failed to cancel mail automation backfill"));
  }
};

export const createIncomingAutomation = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  input: CreateIncomingAutomation;
}): Promise<Result<IncomingAutomation>> => {
  const parsed = createIncomingAutomationSchema.safeParse(params.input);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid incoming automation"));
  const automationId = crypto.randomUUID();
  const name = normalizeName(parsed.data.name);
  const scope = normalizeAutomationScope(parsed.data.scope);
  if (!scope.ok) return scope;
  const actions = incomingAutomationActions(parsed.data.steps);
  const conditions = scopeConditions(scope.data);
  try {
    const result = await sql.begin(async (tx) => {
      unwrap(await lockMailbox(params.context, params.mailboxId, tx));
      unwrap(
        await rejectOwnSenderTargets({
          mailboxId: params.mailboxId,
          conditions,
          db: tx,
        }),
      );
      const [count] = await tx<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM mail.incoming_automations
        WHERE mailbox_id = ${params.mailboxId}::uuid AND deleted_at IS NULL
      `;
      if ((count?.count ?? 0) >= MAX_INCOMING_AUTOMATIONS) {
        unwrap(fail(err.conflict(`A mailbox can have at most ${MAX_INCOMING_AUTOMATIONS} incoming automations`)));
      }
      unwrap(
        await protectMailboxSenders({
          mailboxId: params.mailboxId,
          conditions,
          actions,
          db: tx,
        }),
      );
      unwrap(
        await protectAgainstConflictingAutomations({
          mailboxId: params.mailboxId,
          enabled: parsed.data.enabled,
          conditions,
          actions,
          db: tx,
        }),
      );
      const actor = requestActor(params.context);
      const mandate = incomingAutomationHasSpaces(parsed.data.steps)
        ? unwrap(await createAutomationMandate(params.context, automationId, parsed.data.steps, tx))
        : null;
      if (mandate && !parsed.data.enabled) unwrap(await syncAutomationMandateEnabled(params.context, mandate.id, false, tx));
      const workflow = unwrap(
        await replaceManagedWorkflowInTransaction({
          db: tx,
          context: params.context,
          mailboxId: params.mailboxId,
          workflowId: null,
          name: internalWorkflowName(automationId),
          description: "Managed by Mail incoming automations.",
          priority: 50,
          managedBy: "incoming_automation",
          source: buildIncomingAutomationWorkflowSource({ scope: scope.data, steps: parsed.data.steps }),
          effectBudget: incomingAutomationBudget(parsed.data.steps),
          enabled: parsed.data.enabled,
        }),
      );
      const rows = await withShortIdDb(
        tx,
        "incomingAutomation",
        (db, shortId) => db<IncomingAutomationRow[]>`
        INSERT INTO mail.incoming_automations AS automation (
          id, short_id, mailbox_id, workflow_id, name, normalized_name, scope,
          steps, enabled, created_by_actor_kind, created_by_actor_id,
          mandate_id
        ) VALUES (
          ${automationId}::uuid,
          ${shortId},
          ${params.mailboxId}::uuid,
          ${workflow.id}::uuid,
          ${name},
          lower(regexp_replace(${name}, '\\s+', ' ', 'g')),
          ${scope.data}::jsonb,
          ${parsed.data.steps}::jsonb,
          ${parsed.data.enabled},
          ${actor.kind},
          ${actor.id}::uuid,
          ${mandate?.id ?? null}::uuid
        )
        RETURNING ${incomingAutomationColumns}
      `,
      );
      const [row] = rows;
      if (!row) throw new Error("Incoming automation insert returned no row");
      const automation = mapIncomingAutomation(row);
      const activityId = await recordActivity({ db: tx, context: params.context, automation, action: "incoming_automation.created" });
      await audit.record(
        {
          action: "mail.incoming_automation.create",
          outcome: "allowed",
          actor: auditActorFromRequest(params.context),
          target: { type: "incoming_automation", id: automation.id, label: automation.name },
          requestId: params.context.requestId,
          metadata: { mailboxId: params.mailboxId, workflowId: automation.workflowId, enabled: automation.enabled },
        },
        tx,
      );
      return { automation, activityId };
    });
    await publishAutomationChange(result.automation, result.activityId);
    return ok(result.automation);
  } catch (error) {
    return mutationFailure(error, "Failed to create incoming automation");
  }
};

export const updateIncomingAutomation = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  automationId: string;
  input: UpdateIncomingAutomation;
}): Promise<Result<IncomingAutomation>> => {
  const parsed = updateIncomingAutomationSchema.safeParse(params.input);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid incoming automation"));
  const name = normalizeName(parsed.data.name);
  const scope = normalizeAutomationScope(parsed.data.scope);
  if (!scope.ok) return scope;
  const actions = incomingAutomationActions(parsed.data.steps);
  const conditions = scopeConditions(scope.data);
  try {
    const result = await sql.begin(async (tx) => {
      unwrap(await lockMailbox(params.context, params.mailboxId, tx));
      const current = unwrap(await loadIncomingAutomation(params.mailboxId, params.automationId, tx, true));
      if (current.revision !== parsed.data.expectedRevision) unwrap(fail(err.conflict("Incoming automation was changed")));
      unwrap(
        await rejectOwnSenderTargets({
          mailboxId: params.mailboxId,
          conditions,
          db: tx,
        }),
      );
      unwrap(
        await protectMailboxSenders({
          mailboxId: params.mailboxId,
          conditions,
          actions,
          db: tx,
        }),
      );
      unwrap(
        await protectAgainstConflictingAutomations({
          mailboxId: params.mailboxId,
          automationId: params.automationId,
          enabled: parsed.data.enabled,
          conditions,
          actions,
          db: tx,
        }),
      );
      const definitionChanged =
        sha256Json(current.scope) !== sha256Json(scope.data) || sha256Json(current.steps) !== sha256Json(parsed.data.steps);
      const enabledChanged = current.enabled !== parsed.data.enabled;
      const changed = current.name !== name || definitionChanged || enabledChanged;
      if (!changed) {
        return { automation: current, activityId: null as string | null };
      }
      if (definitionChanged && current.mandateId && !userBackedActor(params.context)) {
        unwrap(fail(err.forbidden("Spaces automation actions require a user-backed actor")));
      }
      const needsSpaces = incomingAutomationHasSpaces(parsed.data.steps);
      let mandateId = current.mandateId;
      if (needsSpaces && current.mandateId) {
        if (definitionChanged) unwrap(await updateAutomationMandate(params.context, current.mandateId, parsed.data.steps, tx));
      } else if (needsSpaces) {
        mandateId = unwrap(await createAutomationMandate(params.context, params.automationId, parsed.data.steps, tx)).id;
      } else if (!needsSpaces) {
        if (current.mandateId) unwrap(await revokeAutomationMandate(current.mandateId, "Spaces actions removed", tx));
        mandateId = null;
      }
      if (mandateId && (enabledChanged || mandateId !== current.mandateId)) {
        unwrap(await syncAutomationMandateEnabled(params.context, mandateId, parsed.data.enabled, tx));
      }
      if (definitionChanged || enabledChanged) unwrap(await rejectActiveBackfillMutation(current));
      if (definitionChanged) {
        unwrap(
          await replaceManagedWorkflowInTransaction({
            db: tx,
            context: params.context,
            mailboxId: params.mailboxId,
            workflowId: current.workflowId,
            name: internalWorkflowName(params.automationId),
            description: "Managed by Mail incoming automations.",
            priority: 50,
            managedBy: "incoming_automation",
            source: buildIncomingAutomationWorkflowSource({ scope: scope.data, steps: parsed.data.steps }),
            effectBudget: incomingAutomationBudget(parsed.data.steps),
            enabled: parsed.data.enabled,
          }),
        );
      } else if (enabledChanged) {
        unwrap(
          await setManagedWorkflowEnabledInTransaction({
            db: tx,
            context: params.context,
            mailboxId: params.mailboxId,
            workflowId: current.workflowId,
            enabled: parsed.data.enabled,
          }),
        );
      }
      await tx`
        UPDATE mail.incoming_automations
        SET
          name = ${name},
          normalized_name = lower(regexp_replace(${name}, '\\s+', ' ', 'g')),
          scope = ${scope.data}::jsonb,
          steps = ${parsed.data.steps}::jsonb,
          enabled = ${parsed.data.enabled},
          latest_backfill_operation_id = CASE WHEN ${definitionChanged} THEN NULL ELSE latest_backfill_operation_id END,
          mandate_id = ${needsSpaces ? mandateId : null}::uuid,
          revision = revision + 1
        WHERE id = ${params.automationId}::uuid AND mailbox_id = ${params.mailboxId}::uuid
      `;
      const automation = unwrap(await loadIncomingAutomation(params.mailboxId, params.automationId, tx));
      const activityId = await recordActivity({ db: tx, context: params.context, automation, action: "incoming_automation.updated" });
      await audit.record(
        {
          action: "mail.incoming_automation.update",
          outcome: "allowed",
          actor: auditActorFromRequest(params.context),
          target: { type: "incoming_automation", id: automation.id, label: automation.name },
          requestId: params.context.requestId,
          metadata: {
            mailboxId: params.mailboxId,
            workflowId: automation.workflowId,
            enabled: automation.enabled,
            revision: automation.revision,
          },
        },
        tx,
      );
      return { automation, activityId };
    });
    if (result.activityId) await publishAutomationChange(result.automation, result.activityId);
    return ok(result.automation);
  } catch (error) {
    return mutationFailure(error, "Failed to update incoming automation");
  }
};

export const setIncomingAutomationEnabled = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  automationId: string;
  input: SetIncomingAutomationEnabled;
}): Promise<Result<IncomingAutomation>> => {
  const parsed = setIncomingAutomationEnabledSchema.safeParse(params.input);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid incoming automation state"));
  try {
    const result = await sql.begin(async (tx) => {
      unwrap(await lockMailbox(params.context, params.mailboxId, tx));
      const current = unwrap(await loadIncomingAutomation(params.mailboxId, params.automationId, tx, true));
      if (current.revision !== parsed.data.expectedRevision) unwrap(fail(err.conflict("Incoming automation was changed")));
      if (current.enabled === parsed.data.enabled) {
        return { automation: current, activityId: null as string | null };
      }
      unwrap(await rejectActiveBackfillMutation(current));
      if (parsed.data.enabled) {
        const validation = await validateMailWorkflowSource({
          context: params.context,
          mailboxId: params.mailboxId,
          source: current.workflowSource,
          db: tx,
        });
        if (!validation.valid) {
          unwrap(fail(err.badInput(validation.diagnostics[0]?.message ?? "Automation setup is no longer available")));
        }
        unwrap(
          await protectMailboxSenders({
            mailboxId: params.mailboxId,
            conditions: scopeConditions(current.scope),
            actions: incomingAutomationActions(current.steps),
            db: tx,
          }),
        );
        unwrap(
          await protectAgainstConflictingAutomations({
            mailboxId: params.mailboxId,
            automationId: params.automationId,
            enabled: true,
            conditions: scopeConditions(current.scope),
            actions: incomingAutomationActions(current.steps),
            db: tx,
          }),
        );
      }
      if (current.mandateId) {
        unwrap(await syncAutomationMandateEnabled(params.context, current.mandateId, parsed.data.enabled, tx));
      }
      unwrap(
        await setManagedWorkflowEnabledInTransaction({
          db: tx,
          context: params.context,
          mailboxId: params.mailboxId,
          workflowId: current.workflowId,
          enabled: parsed.data.enabled,
        }),
      );
      await tx`
        UPDATE mail.incoming_automations
        SET enabled = ${parsed.data.enabled}, revision = revision + 1
        WHERE id = ${params.automationId}::uuid AND mailbox_id = ${params.mailboxId}::uuid
      `;
      const automation = unwrap(await loadIncomingAutomation(params.mailboxId, params.automationId, tx));
      const activityId = await recordActivity({ db: tx, context: params.context, automation, action: "incoming_automation.updated" });
      await audit.record(
        {
          action: "mail.incoming_automation.update",
          outcome: "allowed",
          actor: auditActorFromRequest(params.context),
          target: { type: "incoming_automation", id: automation.id, label: automation.name },
          requestId: params.context.requestId,
          metadata: {
            mailboxId: params.mailboxId,
            workflowId: automation.workflowId,
            enabled: automation.enabled,
            revision: automation.revision,
          },
        },
        tx,
      );
      return { automation, activityId };
    });
    if (result.activityId) await publishAutomationChange(result.automation, result.activityId);
    return ok(result.automation);
  } catch (error) {
    return mutationFailure(error, "Failed to change incoming automation");
  }
};

export const deleteIncomingAutomation = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  automationId: string;
  input: DeleteIncomingAutomation;
}): Promise<Result<IncomingAutomation>> => {
  const parsed = deleteIncomingAutomationSchema.safeParse(params.input);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid incoming automation deletion"));
  try {
    const result = await sql.begin(async (tx) => {
      unwrap(await lockMailbox(params.context, params.mailboxId, tx));
      const current = unwrap(await loadIncomingAutomation(params.mailboxId, params.automationId, tx, true));
      if (current.revision !== parsed.data.expectedRevision) unwrap(fail(err.conflict("Incoming automation was changed")));
      if (current.mandateId && !userBackedActor(params.context)) {
        unwrap(fail(err.forbidden("Spaces automation actions require a user-backed actor")));
      }
      if (current.mandateId) {
        unwrap(await revokeAutomationMandate(current.mandateId, "Incoming automation deleted", tx));
      }
      unwrap(await rejectActiveBackfillMutation(current));
      unwrap(
        await setManagedWorkflowEnabledInTransaction({
          db: tx,
          context: params.context,
          mailboxId: params.mailboxId,
          workflowId: current.workflowId,
          enabled: false,
        }),
      );
      const [row] = await tx<IncomingAutomationRow[]>`
        UPDATE mail.incoming_automations AS automation
        SET enabled = false, mandate_id = NULL, revision = revision + 1, deleted_at = now()
        WHERE automation.id = ${params.automationId}::uuid AND automation.mailbox_id = ${params.mailboxId}::uuid
        RETURNING ${incomingAutomationColumns}
      `;
      if (!row) throw new Error("Deleted incoming automation could not be reloaded");
      const automation = mapIncomingAutomation(row);
      const activityId = await recordActivity({ db: tx, context: params.context, automation, action: "incoming_automation.deleted" });
      await audit.record(
        {
          action: "mail.incoming_automation.delete",
          outcome: "allowed",
          actor: auditActorFromRequest(params.context),
          target: { type: "incoming_automation", id: automation.id, label: automation.name },
          requestId: params.context.requestId,
          metadata: { mailboxId: params.mailboxId, workflowId: automation.workflowId, revision: automation.revision },
        },
        tx,
      );
      return { automation, activityId };
    });
    await publishAutomationChange(result.automation, result.activityId);
    return ok(result.automation);
  } catch (error) {
    return mutationFailure(error, "Failed to delete incoming automation");
  }
};
