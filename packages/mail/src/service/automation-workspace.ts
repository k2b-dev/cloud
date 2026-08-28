import { err, fail, ok, type Result } from "@k2b/stdlib";
import { logger, trace } from "@valentinkolb/cloud/services";
import { listWorkflowRuns } from "@valentinkolb/cloud/workflows/store";
import type { Mailbox, MailWorkflow, SenderIdentity } from "../contracts";
import { type MailWorkflowCatalogSnapshot, snapshotMailWorkflowCatalog } from "../workflows/catalog";
import * as access from "./access";
import type { MailRequestContext } from "./auth";
import { requireAutomaticReplyManagementPermission } from "./automatic-reply-access";
import type { AutomaticReplyConfiguration } from "./automatic-reply-configuration";
import * as automaticReplies from "./automatic-reply-configuration";
import {
  type MailAutomationActivityItem,
  mailBackfillWorkflowId,
  projectMailBackfillActivity,
  projectMailWorkflowActivity,
  summarizeMailAutomationActivity,
} from "./automation-activity";
import type { ConversationReferenceConfiguration } from "./conversation-reference";
import * as conversationReferences from "./conversation-reference";
import type { IncomingAutomation, IncomingAutomationActivityMetadata } from "./incoming-automations";
import * as incomingAutomations from "./incoming-automations";
import * as mailboxes from "./mailboxes";
import * as senderIdentities from "./sender-identities";
import { loadMailWorkflowCatalog } from "./workflow-catalog-service";
import * as workflows from "./workflows";

const log = logger("mail:automation-workspace");

export type MailAutomationAccessData = {
  mailbox: Mailbox;
  permission: "read" | "write" | "admin";
};

export type MailAutomationOverviewData = MailAutomationAccessData & {
  canManageAutomaticReplies: boolean;
  automaticReplies: AutomaticReplyConfiguration[];
  incomingAutomations: IncomingAutomation[] | null;
  customWorkflows: MailWorkflow[] | null;
  recentActivity: MailAutomationActivityItem[] | null;
};

export type MailAutomaticRepliesWorkspaceData = MailAutomationAccessData & {
  canManageAutomaticReplies: boolean;
  identities: SenderIdentity[];
  automaticReplies: AutomaticReplyConfiguration[];
  referenceConfiguration: ConversationReferenceConfiguration | null;
};

export type MailIncomingAutomationsWorkspaceData = MailAutomationAccessData & {
  incomingAutomations: IncomingAutomation[];
  catalog: MailWorkflowCatalogSnapshot;
};

export type MailWorkflowsWorkspaceData = MailAutomationAccessData & {
  workflows: MailWorkflow[];
  referenceConfiguration: ConversationReferenceConfiguration | null;
};

export type {
  MailAutomationActivityItem,
  MailAutomationActivityKind,
  MailAutomationActivityStatus,
} from "./automation-activity";

export type MailAutomationActivityData = MailAutomationAccessData & {
  items: MailAutomationActivityItem[];
  counts: {
    total: number;
    active: number;
    failed: number;
    backfills: number;
  };
};

const loadAccess = async (context: MailRequestContext, mailboxId: string): Promise<Result<MailAutomationAccessData>> => {
  const permission = await access.getMailboxPermission(context, mailboxId);
  if (permission === "none") return fail(err.forbidden("Access denied"));
  const mailboxResult = await mailboxes.getMailbox(context, mailboxId);
  if (!mailboxResult.ok) return fail(mailboxResult.error);
  return ok({ mailbox: mailboxResult.data, permission });
};

const loadAdminAccess = async (context: MailRequestContext, mailboxId: string): Promise<Result<MailAutomationAccessData>> => {
  const result = await loadAccess(context, mailboxId);
  if (!result.ok) return result;
  return result.data.permission === "admin" ? result : fail(err.forbidden("Mailbox administration permission required"));
};

const customWorkflows = (
  definitions: MailWorkflow[],
  replies: AutomaticReplyConfiguration[],
  automations: IncomingAutomation[],
): MailWorkflow[] => {
  const managedIds = new Set([...replies.map((item) => item.workflowId), ...automations.map((item) => item.workflowId)]);
  return definitions.filter((workflow) => !managedIds.has(workflow.id));
};

const loadActivityItems = async (
  context: MailRequestContext,
  mailboxId: string,
  replies: AutomaticReplyConfiguration[],
  limit = 200,
  locale = "en",
): Promise<MailAutomationActivityItem[]> => {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000);
  const [runs, backfills] = await Promise.all([
    listWorkflowRuns({ appId: "mail", scopeId: mailboxId, since, limit }),
    trace.list(
      { page: 1, perPage: limit, offset: 0 },
      {
        filter: {
          appId: "mail",
          source: "mail:incoming-automation-backfill",
          category: "backfill",
          window: "30d",
          attributeEquals: { "mail.mailbox.id": mailboxId },
        },
      },
    ),
  ]);
  const replyWorkflowIds = new Set(replies.map((configuration) => configuration.workflowId));
  const automationResult = await incomingAutomations.listIncomingAutomationActivityMetadata(context, mailboxId, [
    ...runs.map((run) => run.workflowId),
    ...backfills.spans.flatMap((span) => {
      const workflowId = mailBackfillWorkflowId(span);
      return workflowId ? [workflowId] : [];
    }),
  ]);
  if (!automationResult.ok) throw new Error(automationResult.error.message);
  const automations: IncomingAutomationActivityMetadata[] = automationResult.data;
  const incomingAutomationWorkflowIds = new Set(automations.map((automation) => automation.workflowId));
  const automationNames = new Map(automations.map((automation) => [automation.id, automation.name]));
  const workflowNames = new Map([
    ...replies.map((configuration) => [configuration.workflowId, configuration.name] as const),
    ...automations.map((automation) => [automation.workflowId, automation.name] as const),
  ]);
  return [
    ...runs.map((run) =>
      projectMailWorkflowActivity({ mailboxId, run, replyWorkflowIds, incomingAutomationWorkflowIds, workflowNames, locale }),
    ),
    ...backfills.spans.map((span) => projectMailBackfillActivity({ mailboxId, span, automationNames, locale })),
  ]
    .toSorted((left, right) => right.occurredAt.localeCompare(left.occurredAt))
    .slice(0, limit);
};

export const loadMailAutomationOverview = async (
  context: MailRequestContext,
  mailboxId: string,
  locale = "en",
): Promise<Result<MailAutomationOverviewData>> => {
  const accessResult = await loadAccess(context, mailboxId);
  if (!accessResult.ok) return accessResult;
  const [replyResult, managementPermission] = await Promise.all([
    automaticReplies.listAutomaticReplyConfigurations(context, mailboxId),
    requireAutomaticReplyManagementPermission(context, mailboxId),
  ]);
  if (!replyResult.ok) return fail(replyResult.error);

  if (accessResult.data.permission !== "admin") {
    return ok({
      ...accessResult.data,
      canManageAutomaticReplies: managementPermission.ok,
      automaticReplies: replyResult.data,
      incomingAutomations: null,
      customWorkflows: null,
      recentActivity: null,
    });
  }

  const [automationResult, workflowResult] = await Promise.all([
    incomingAutomations.listIncomingAutomations(context, mailboxId),
    workflows.listWorkflows(context, mailboxId),
  ]);
  if (!automationResult.ok) return fail(automationResult.error);
  if (!workflowResult.ok) return fail(workflowResult.error);
  const recentActivity = await loadActivityItems(context, mailboxId, replyResult.data, 8, locale).catch((error) => {
    log.warn("Failed to load recent Mail automation activity", {
      mailboxId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
  return ok({
    ...accessResult.data,
    canManageAutomaticReplies: true,
    automaticReplies: replyResult.data,
    incomingAutomations: automationResult.data,
    customWorkflows: customWorkflows(workflowResult.data, replyResult.data, automationResult.data),
    recentActivity,
  });
};

export const loadMailAutomaticRepliesWorkspace = async (
  context: MailRequestContext,
  mailboxId: string,
): Promise<Result<MailAutomaticRepliesWorkspaceData>> => {
  const accessResult = await loadAccess(context, mailboxId);
  if (!accessResult.ok) return accessResult;
  const [identityResult, replyResult, referenceResult, managementPermission] = await Promise.all([
    senderIdentities.listSenderIdentities(context, mailboxId),
    automaticReplies.listAutomaticReplyConfigurations(context, mailboxId),
    conversationReferences.getConversationReferenceConfiguration(context, mailboxId),
    requireAutomaticReplyManagementPermission(context, mailboxId),
  ]);
  if (!identityResult.ok) return fail(identityResult.error);
  if (!replyResult.ok) return fail(replyResult.error);
  if (!referenceResult.ok) return fail(referenceResult.error);
  return ok({
    ...accessResult.data,
    canManageAutomaticReplies: managementPermission.ok,
    identities: identityResult.data,
    automaticReplies: replyResult.data,
    referenceConfiguration: referenceResult.data,
  });
};

export const loadMailIncomingAutomationsWorkspace = async (
  context: MailRequestContext,
  mailboxId: string,
): Promise<Result<MailIncomingAutomationsWorkspaceData>> => {
  const accessResult = await loadAdminAccess(context, mailboxId);
  if (!accessResult.ok) return accessResult;
  const [automationResult, catalog] = await Promise.all([
    incomingAutomations.listIncomingAutomations(context, mailboxId),
    loadMailWorkflowCatalog({ context, mailboxId }),
  ]);
  if (!automationResult.ok) return fail(automationResult.error);
  return ok({
    ...accessResult.data,
    incomingAutomations: automationResult.data,
    catalog: snapshotMailWorkflowCatalog(catalog),
  });
};

export const loadMailWorkflowsWorkspace = async (
  context: MailRequestContext,
  mailboxId: string,
): Promise<Result<MailWorkflowsWorkspaceData>> => {
  const accessResult = await loadAdminAccess(context, mailboxId);
  if (!accessResult.ok) return accessResult;
  const [workflowResult, replyResult, automationResult, referenceResult] = await Promise.all([
    workflows.listWorkflows(context, mailboxId),
    automaticReplies.listAutomaticReplyConfigurations(context, mailboxId),
    incomingAutomations.listIncomingAutomations(context, mailboxId),
    conversationReferences.getConversationReferenceConfiguration(context, mailboxId),
  ]);
  if (!workflowResult.ok) return fail(workflowResult.error);
  if (!replyResult.ok) return fail(replyResult.error);
  if (!automationResult.ok) return fail(automationResult.error);
  if (!referenceResult.ok) return fail(referenceResult.error);
  return ok({
    ...accessResult.data,
    workflows: customWorkflows(workflowResult.data, replyResult.data, automationResult.data),
    referenceConfiguration: referenceResult.data,
  });
};

export const loadMailAutomationActivity = async (
  context: MailRequestContext,
  mailboxId: string,
  locale = "en",
): Promise<Result<MailAutomationActivityData>> => {
  const accessResult = await loadAdminAccess(context, mailboxId);
  if (!accessResult.ok) return accessResult;
  const replyResult = await automaticReplies.listAutomaticReplyConfigurations(context, mailboxId);
  if (!replyResult.ok) return fail(replyResult.error);
  let items: MailAutomationActivityItem[];
  try {
    items = await loadActivityItems(context, mailboxId, replyResult.data, 200, locale);
  } catch (error) {
    log.error("Failed to load Mail automation activity", {
      mailboxId,
      error: error instanceof Error ? error.message : String(error),
    });
    return fail(err.internal("Failed to load automation activity"));
  }
  return ok({
    ...accessResult.data,
    items,
    counts: summarizeMailAutomationActivity(items),
  });
};
