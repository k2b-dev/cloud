import { err, fail, i18n, isServiceError, ok, type Result, unwrap } from "@k2b/stdlib";
import { audit } from "@valentinkolb/cloud/services";
import { sql } from "bun";
import { stringify } from "yaml";
import { z } from "zod";
import {
  type AutomaticReplyInactiveBehavior,
  type AutomaticReplyPreview,
  type AutomaticReplyPreviewInput,
  automaticReplyPreviewInputSchema,
  type CreateAutomaticReplyConfiguration,
  type CreateAutomaticReplySetup,
  createAutomaticReplyConfigurationSchema,
  createAutomaticReplySetupSchema,
  type PutConversationReferenceConfiguration,
  type ResponseScheduleDefinitionInput,
  type UpdateAutomaticReplyConfiguration,
  type UpdateAutomaticReplySetup,
  updateAutomaticReplyConfigurationSchema,
  updateAutomaticReplySetupSchema,
  type WorkflowEffectBudget,
} from "../contracts";
import { withShortIdDb } from "../lib/short-id";
import { requireMailboxPermission } from "./access";
import { actorRefFromRequest, auditActorFromRequest, type MailRequestContext } from "./auth";
import { cancelPendingAutomaticRepliesInTransaction } from "./automatic-reply";
import { requireAutomaticReplyManagementPermission } from "./automatic-reply-access";
import { renderComposeDraft } from "./compose-templates";
import {
  type ConversationReferenceConfiguration,
  type ConversationReferenceConfigurationMutation,
  formatConversationReference,
  putConversationReferenceConfigurationInTransaction,
} from "./conversation-reference";
import { publishMailMailboxEvent } from "./events";
import {
  decodeStoredResponseScheduleDefinition,
  normalizeResponseScheduleDefinition,
  type ResponseScheduleDefinition,
} from "./response-schedule";
import { renderMailLiquidTemplate } from "./template-rendering";
import type { SqlClient } from "./workflow-data";
import { replaceManagedWorkflowInTransaction, setManagedWorkflowEnabledInTransaction } from "./workflow-definition-service";

const internalAutomaticReplyPreviewInputSchema = automaticReplyPreviewInputSchema.safeExtend({ senderIdentityId: z.string().uuid() });
const internalCreateAutomaticReplySetupSchema = createAutomaticReplySetupSchema.safeExtend({
  automaticReply: createAutomaticReplyConfigurationSchema.extend({ senderIdentityId: z.string().uuid() }),
});
const internalUpdateAutomaticReplySetupSchema = updateAutomaticReplySetupSchema.safeExtend({
  automaticReply: updateAutomaticReplyConfigurationSchema.extend({ senderIdentityId: z.string().uuid() }),
});

export type AutomaticReplyConfiguration = {
  id: string;
  mailboxId: string;
  workflowId: string;
  name: string;
  enabled: boolean;
  senderIdentityId: string;
  subject: string;
  body: string;
  format: "plain" | "markdown";
  ensureReference: boolean;
  minimumIntervalHours: number;
  inactiveBehavior: AutomaticReplyInactiveBehavior;
  schedule: ResponseScheduleDefinition;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type AutomaticReplySetup = {
  automaticReply: AutomaticReplyConfiguration;
  referenceConfiguration: ConversationReferenceConfiguration | null;
};

const previewMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      subject: "Example customer request",
      body: "Hello, I would like to know more.",
      customer: "Example Customer",
      support: "Support",
    },
    de: {
      subject: "Beispielanfrage eines Kunden",
      body: "Guten Tag, ich würde gerne mehr erfahren.",
      customer: "Beispielkunde",
      support: "Support",
    },
  },
});

const automaticReplyPreviewData = (params: {
  mailboxId: string;
  context: MailRequestContext;
  referenceValue: string | null;
  locale?: string;
}) => {
  const actor = actorRefFromRequest(params.context);
  const occurredAt = new Date().toISOString();
  const t = previewMessages.resolve([params.locale ?? "en"]).t;
  return {
    inputs: {
      message: {
        id: "00000000-0000-4000-8000-000000000001",
        conversationId: "00000000-0000-4000-8000-000000000002",
        subject: t.subject,
        body: t.body,
        bodyText: t.body,
        bodyHtml: `<p>${t.body}</p>`,
        fromAddress: "customer@example.test",
        fromDomain: "example.test",
        sender: [{ role: "from", name: t.customer, email: "customer@example.test" }],
        recipients: [{ role: "to", name: t.support, email: "support@example.test" }],
        attachments: [
          {
            id: "00000000-0000-4000-8000-000000000003",
            filename: "request.pdf",
            contentType: "application/pdf",
            disposition: "attachment",
            contentId: null,
            sizeBytes: 42_000,
          },
        ],
        hasAttachments: true,
        folderId: "00000000-0000-4000-8000-000000000004",
        flags: [],
        keywords: [],
        direction: "inbound",
        internalDate: occurredAt,
        receivedAt: occurredAt,
      },
      conversation: {
        id: "00000000-0000-4000-8000-000000000002",
        subject: t.subject,
        assigneeUserId: null,
        workStatus: "needs_action",
        latestMessageAt: occurredAt,
      },
    },
    context: {
      mailboxId: params.mailboxId,
      actor:
        actor.kind === "user"
          ? { userId: actor.userId, serviceAccountId: null, groupIds: [] }
          : actor.kind === "service_account"
            ? { userId: null, serviceAccountId: actor.serviceAccountId, groupIds: [] }
            : { userId: null, serviceAccountId: null, groupIds: [] },
      occurredAt,
    },
    ...(params.referenceValue
      ? {
          reference: {
            id: "00000000-0000-4000-8000-000000000005",
            value: params.referenceValue,
            created: true,
            conversationId: "00000000-0000-4000-8000-000000000002",
            conversationRevision: 1,
          },
        }
      : {}),
  };
};

const escapePreviewHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const previewAutomaticReply = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  input: AutomaticReplyPreviewInput;
  locale?: string;
}): Promise<Result<AutomaticReplyPreview>> => {
  const parsed = internalAutomaticReplyPreviewInputSchema.safeParse(params.input);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid automatic reply preview"));
  const allowed = await requireAutomaticReplyManagementPermission(params.context, params.mailboxId);
  if (!allowed.ok) return allowed;
  const input = parsed.data;
  const allocatedAt = new Date();
  const reference =
    input.ensureReference && input.referencePattern
      ? formatConversationReference({
          pattern: input.referencePattern,
          sequence: 42n,
          allocatedAt,
        })
      : ok<string | null>(null);
  if (!reference.ok) return reference;
  const data = automaticReplyPreviewData({
    mailboxId: params.mailboxId,
    context: params.context,
    referenceValue: reference.data,
    locale: params.locale,
  });
  const subject = renderMailLiquidTemplate(input.subject, data, "text");
  if (!subject.ok) return subject;
  const body = renderMailLiquidTemplate(input.body, data, input.format === "markdown" ? "markdown" : "text");
  if (!body.ok) return body;
  const rendered = await renderComposeDraft({
    mailboxId: params.mailboxId,
    draft: {
      senderIdentityId: input.senderIdentityId,
      to: [],
      cc: [],
      bcc: [],
      subject: subject.data,
      body: body.data,
      format: input.format,
    },
    actor: actorRefFromRequest(params.context),
    renderLiquid: false,
  });
  if (!rendered.ok) return rendered;
  return ok({
    subject: subject.data,
    html: rendered.data.html ?? `<pre>${escapePreviewHtml(rendered.data.text)}</pre>`,
    text: rendered.data.text,
  });
};

type AutomaticReplyConfigurationRow = {
  id: string;
  short_id: string;
  mailbox_id: string;
  workflow_id: string;
  sender_identity_id: string;
  name: string;
  subject: string;
  body: string;
  format: "plain" | "markdown";
  ensure_reference: boolean;
  minimum_interval_hours: number;
  inactive_behavior: AutomaticReplyInactiveBehavior;
  enabled: boolean;
  revision: string | number;
  schedule_definition: unknown;
  created_at: Date | string;
  updated_at: Date | string;
};

type ConfigurationActor = { kind: "user" | "service_account"; id: string };

const configurationColumns = sql`
  configuration.id,
  configuration.short_id,
  configuration.mailbox_id,
  configuration.workflow_id,
  configuration.sender_identity_id,
  configuration.name,
  configuration.subject,
  configuration.body,
  configuration.format,
  configuration.ensure_reference,
  configuration.minimum_interval_hours,
  configuration.inactive_behavior,
  configuration.enabled,
  configuration.revision,
  configuration.schedule_definition,
  configuration.created_at,
  configuration.updated_at
`;

const managedWorkflowBudget = (ensureReference: boolean): WorkflowEffectBudget => ({
  maxTargets: 1,
  maxMoves: 0,
  maxSends: 1,
  maxKeywordChanges: 0,
  maxCollaborationChanges: ensureReference ? 1 : 0,
  maxAiCalls: 0,
});

const toIso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();
const normalizeName = (value: string): string => value.trim().replace(/\s+/gu, " ");
const internalResourceName = (id: string): string => `Automatic reply ${id}`;

const requestActor = (context: MailRequestContext): ConfigurationActor => {
  const actor = actorRefFromRequest(context);
  if (actor.kind === "user") return { kind: actor.kind, id: actor.userId };
  if (actor.kind === "service_account") return { kind: actor.kind, id: actor.serviceAccountId };
  throw new TypeError("Request actor cannot configure automatic replies");
};

const mapConfiguration = async (row: AutomaticReplyConfigurationRow, db: SqlClient): Promise<Result<AutomaticReplyConfiguration>> => {
  const schedule = decodeStoredResponseScheduleDefinition(row.schedule_definition);
  if (!schedule.ok) return schedule;
  return ok({
    id: row.id,
    mailboxId: row.mailbox_id,
    workflowId: row.workflow_id,
    name: row.name,
    enabled: row.enabled,
    senderIdentityId: row.sender_identity_id,
    subject: row.subject,
    body: row.body,
    format: row.format,
    ensureReference: row.ensure_reference,
    minimumIntervalHours: row.minimum_interval_hours,
    inactiveBehavior: row.inactive_behavior,
    schedule: schedule.data,
    revision: Number(row.revision),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
};

const buildWorkflowSource = (params: {
  senderIdentityId: string;
  schedule: ResponseScheduleDefinition;
  subject: string;
  body: string;
  format: "plain" | "markdown";
  ensureReference: boolean;
  minimumIntervalHours: number;
  inactiveBehavior: AutomaticReplyInactiveBehavior;
}): string =>
  stringify(
    {
      inputs: {
        message: { type: "mailMessage", required: true },
        conversation: { type: "mailConversation", required: true },
      },
      triggers: {
        messageReceived: {
          with: {
            message: "${{ trigger.message }}",
            conversation: "${{ trigger.conversation }}",
          },
        },
      },
      steps: [
        ...(params.ensureReference
          ? [
              {
                ensureConversationReference: {
                  conversation: "${{ inputs.conversation }}",
                  saveAs: "reference",
                },
              },
            ]
          : []),
        {
          automaticReply: {
            message: "${{ inputs.message }}",
            conversation: "${{ inputs.conversation }}",
            sender: params.senderIdentityId,
            schedule: params.schedule,
            subject: params.subject,
            body: params.body,
            format: params.format,
            minimumIntervalHours: params.minimumIntervalHours,
            inactiveBehavior: params.inactiveBehavior,
          },
        },
      ],
    },
    { lineWidth: 0 },
  );

const validateManagedSchedule = (definition: ResponseScheduleDefinitionInput): Result<ResponseScheduleDefinition> => {
  const schedule = normalizeResponseScheduleDefinition(definition);
  if (!schedule.ok) return schedule;
  if (
    schedule.data.mode === "windows" &&
    schedule.data.weeklyWindows.length === 0 &&
    !schedule.data.exceptions.some((exception) => !exception.closed && exception.windows.length > 0)
  ) {
    return fail(err.badInput("At least one active response window is required"));
  }
  return schedule;
};

const senderWorkflowResourceId = async (db: SqlClient, mailboxId: string, senderIdentityId: string): Promise<Result<string>> => {
  const [identity] = await db<{ short_id: string }[]>`
    SELECT short_id
    FROM mail.sender_identities
    WHERE id = ${senderIdentityId}::uuid
      AND mailbox_id = ${mailboxId}::uuid
  `;
  return identity ? ok(identity.short_id) : fail(err.badInput("The selected sender identity is not available"));
};

const requireAutomationSender = async (db: SqlClient, mailboxId: string, senderIdentityId: string): Promise<Result<string>> => {
  const [identity] = await db<{ short_id: string }[]>`
    SELECT short_id
    FROM mail.sender_identities
    WHERE id = ${senderIdentityId}::uuid
      AND mailbox_id = ${mailboxId}::uuid
      AND status = 'verified'
      AND automation_policy = 'mailbox'
    FOR SHARE
  `;
  return identity
    ? ok(identity.short_id)
    : fail(
        err.badInput("Select a verified identity with Automatic replies enabled in Settings > Accounts & identities > Sending identities"),
      );
};

const requireReferenceConfiguration = async (db: SqlClient, mailboxId: string): Promise<Result<void>> => {
  const [configuration] = await db<{ mailbox_id: string }[]>`
    SELECT mailbox_id
    FROM mail.reference_number_configurations
    WHERE mailbox_id = ${mailboxId}::uuid AND enabled
    FOR SHARE
  `;
  return configuration ? ok() : fail(err.badInput("Set up and enable reference numbers before assigning them in an automatic reply"));
};

const requireActivationAvailable = async (db: SqlClient, mailboxId: string, configurationId: string | null): Promise<Result<void>> => {
  const [active] = await db<{ id: string }[]>`
    SELECT id
    FROM mail.automatic_reply_configurations
    WHERE mailbox_id = ${mailboxId}::uuid
      AND enabled
      AND (${configurationId}::uuid IS NULL OR id <> ${configurationId}::uuid)
    LIMIT 1
  `;
  return active ? fail(err.conflict("Disable the active automatic reply before enabling another one")) : ok();
};

const lockMailboxForAutomaticReply = async (context: MailRequestContext, mailboxId: string, db: SqlClient): Promise<Result<void>> => {
  const [mailbox] = await db<{ id: string }[]>`
    SELECT id
    FROM mail.mailboxes
    WHERE id = ${mailboxId}::uuid AND deleted_at IS NULL
    FOR UPDATE
  `;
  if (!mailbox) return fail(err.notFound("Mailbox"));
  const allowed = await requireAutomaticReplyManagementPermission(context, mailboxId, db);
  return allowed.ok ? ok() : allowed;
};

const insertActivity = async (params: {
  db: SqlClient;
  context: MailRequestContext;
  configuration: AutomaticReplyConfiguration;
  configurationId: string;
  mailboxId: string;
  action: "automatic_reply_configuration.created" | "automatic_reply_configuration.updated";
}): Promise<string> => {
  const actor = requestActor(params.context);
  const [activity] = await params.db<{ id: string | number }[]>`
    INSERT INTO mail.activity_events (
      mailbox_id, actor_kind, actor_id, action, outcome, target_type, target_id, metadata
    ) VALUES (
      ${params.mailboxId}::uuid,
      ${actor.kind},
      ${actor.id}::uuid,
      ${params.action},
      'confirmed',
      'automatic_reply_configuration',
      ${params.configurationId}::uuid,
      ${{
        name: params.configuration.name,
        enabled: params.configuration.enabled,
        revision: params.configuration.revision,
        workflowId: params.configuration.workflowId,
      }}::jsonb
    )
    RETURNING id
  `;
  if (!activity) throw new Error("Automatic reply activity insert returned no row");
  return String(activity.id);
};

const databaseCode = (error: unknown): string | null => {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const value = current as { code?: unknown; errno?: unknown; sqlState?: unknown; cause?: unknown };
    for (const candidate of [value.errno, value.sqlState, value.code]) {
      if (typeof candidate === "string" || typeof candidate === "number") {
        const code = String(candidate);
        if (/^\d{5}$/.test(code)) return code;
      }
    }
    current = value.cause;
  }
  return null;
};

const mutationFailure = (error: unknown, fallback: string): Result<never> => {
  if (isServiceError(error)) return fail(error);
  if (databaseCode(error) === "23505") return fail(err.conflict("Automatic reply name already exists"));
  return fail(err.internal(fallback));
};

const loadConfiguration = async (
  mailboxId: string,
  configurationId: string,
  db: SqlClient,
  lock = false,
): Promise<Result<AutomaticReplyConfiguration>> => {
  const [row] = await db<AutomaticReplyConfigurationRow[]>`
    SELECT ${configurationColumns}
    FROM mail.automatic_reply_configurations configuration
    WHERE configuration.id = ${configurationId}::uuid
      AND configuration.mailbox_id = ${mailboxId}::uuid
    ${lock ? sql`FOR UPDATE OF configuration` : sql``}
  `;
  return row ? mapConfiguration(row, db) : fail(err.notFound("Automatic reply"));
};

const automaticReplyChanges = (
  current: AutomaticReplyConfiguration,
  input: UpdateAutomaticReplyConfiguration,
  schedule: ResponseScheduleDefinition,
  name: string,
): {
  senderChanged: boolean;
  executionChanged: boolean;
  enabledChanged: boolean;
  changed: boolean;
} => {
  const senderChanged = current.senderIdentityId !== input.senderIdentityId;
  const executionChanged =
    senderChanged ||
    current.subject !== input.subject ||
    current.body !== input.body ||
    current.format !== input.format ||
    current.ensureReference !== input.ensureReference ||
    current.minimumIntervalHours !== input.minimumIntervalHours ||
    current.inactiveBehavior !== input.inactiveBehavior ||
    JSON.stringify(current.schedule) !== JSON.stringify(schedule);
  const enabledChanged = current.enabled !== input.enabled;
  return {
    senderChanged,
    executionChanged,
    enabledChanged,
    changed: current.name !== name || enabledChanged || executionChanged,
  };
};

const putInlineReferenceConfiguration = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  input: PutConversationReferenceConfiguration | undefined;
  db: SqlClient;
}): Promise<ConversationReferenceConfigurationMutation | null> =>
  params.input
    ? unwrap(
        await putConversationReferenceConfigurationInTransaction({
          context: params.context,
          mailboxId: params.mailboxId,
          input: params.input,
          db: params.db,
        }),
      )
    : null;

const applyAutomaticReplyWorkflowUpdate = async (params: {
  db: SqlClient;
  context: MailRequestContext;
  mailboxId: string;
  configurationId: string;
  current: AutomaticReplyConfiguration;
  input: UpdateAutomaticReplyConfiguration;
  schedule: ResponseScheduleDefinition;
  executionChanged: boolean;
  enabledChanged: boolean;
  workflowSenderIdentityId: string | null;
}): Promise<void> => {
  if (params.executionChanged || (params.enabledChanged && !params.input.enabled)) {
    await cancelPendingAutomaticRepliesInTransaction({
      db: params.db,
      mailboxId: params.mailboxId,
      workflowId: params.current.workflowId,
      code: "AUTOMATIC_REPLY_CONFIGURATION_CHANGED",
      message: "Automatic reply configuration changed before delivery",
    });
  }
  if (params.executionChanged) {
    if (!params.workflowSenderIdentityId) throw new Error("Automatic reply workflow sender is unavailable");
    unwrap(
      await replaceManagedWorkflowInTransaction({
        db: params.db,
        context: params.context,
        mailboxId: params.mailboxId,
        workflowId: params.current.workflowId,
        name: internalResourceName(params.configurationId),
        description: "Managed by Mail automatic replies.",
        priority: 100,
        managedBy: "automatic_reply",
        source: buildWorkflowSource({
          senderIdentityId: params.workflowSenderIdentityId,
          schedule: params.schedule,
          subject: params.input.subject,
          body: params.input.body,
          format: params.input.format,
          ensureReference: params.input.ensureReference,
          minimumIntervalHours: params.input.minimumIntervalHours,
          inactiveBehavior: params.input.inactiveBehavior,
        }),
        effectBudget: managedWorkflowBudget(params.input.ensureReference),
        enabled: params.input.enabled,
      }),
    );
  } else if (params.enabledChanged) {
    unwrap(
      await setManagedWorkflowEnabledInTransaction({
        db: params.db,
        context: params.context,
        mailboxId: params.mailboxId,
        workflowId: params.current.workflowId,
        enabled: params.input.enabled,
      }),
    );
  }
};

export const listAutomaticReplyConfigurations = async (
  context: MailRequestContext,
  mailboxId: string,
): Promise<Result<AutomaticReplyConfiguration[]>> => {
  const allowed = await requireMailboxPermission(context, mailboxId, "read");
  if (!allowed.ok) return allowed;
  const rows = await sql<AutomaticReplyConfigurationRow[]>`
    SELECT ${configurationColumns}
    FROM mail.automatic_reply_configurations configuration
    WHERE configuration.mailbox_id = ${mailboxId}::uuid
    ORDER BY configuration.enabled DESC, configuration.normalized_name, configuration.id
  `;
  const configurations: AutomaticReplyConfiguration[] = [];
  for (const row of rows) {
    const configuration = await mapConfiguration(row, sql);
    if (!configuration.ok) return configuration;
    configurations.push(configuration.data);
  }
  return ok(configurations);
};

export const createAutomaticReplySetup = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  input: CreateAutomaticReplySetup;
}): Promise<Result<AutomaticReplySetup>> => {
  const parsed = internalCreateAutomaticReplySetupSchema.safeParse(params.input);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid automatic reply"));
  const automaticReply = parsed.data.automaticReply;
  const schedule = validateManagedSchedule(automaticReply.schedule);
  if (!schedule.ok) return schedule;
  const configurationId = crypto.randomUUID();
  const name = normalizeName(automaticReply.name);
  try {
    const result = await sql.begin(
      async (
        tx,
      ): Promise<{
        configuration: AutomaticReplyConfiguration;
        activityId: string;
        referenceConfiguration: ConversationReferenceConfiguration | null;
        referenceActivityId: string | null;
      }> => {
        unwrap(await lockMailboxForAutomaticReply(params.context, params.mailboxId, tx));
        const workflowSenderIdentityId = unwrap(await requireAutomationSender(tx, params.mailboxId, automaticReply.senderIdentityId));
        const senderIdentityId = automaticReply.senderIdentityId;
        const referenceMutation = await putInlineReferenceConfiguration({
          context: params.context,
          mailboxId: params.mailboxId,
          input: parsed.data.referenceConfiguration,
          db: tx,
        });
        if (automaticReply.ensureReference) unwrap(await requireReferenceConfiguration(tx, params.mailboxId));
        if (automaticReply.enabled) unwrap(await requireActivationAvailable(tx, params.mailboxId, null));
        const actor = requestActor(params.context);
        const internalName = internalResourceName(configurationId);
        const workflow = unwrap(
          await replaceManagedWorkflowInTransaction({
            db: tx,
            context: params.context,
            mailboxId: params.mailboxId,
            workflowId: null,
            name: internalName,
            description: "Managed by Mail automatic replies.",
            priority: 100,
            managedBy: "automatic_reply",
            source: buildWorkflowSource({
              senderIdentityId: workflowSenderIdentityId,
              schedule: schedule.data,
              subject: automaticReply.subject,
              body: automaticReply.body,
              format: automaticReply.format,
              ensureReference: automaticReply.ensureReference,
              minimumIntervalHours: automaticReply.minimumIntervalHours,
              inactiveBehavior: automaticReply.inactiveBehavior,
            }),
            effectBudget: managedWorkflowBudget(automaticReply.ensureReference),
            enabled: automaticReply.enabled,
          }),
        );
        const workflowId = workflow.id;
        const rows = await withShortIdDb(
          tx,
          "automaticReplyConfiguration",
          (db, shortId) => db<AutomaticReplyConfigurationRow[]>`
          INSERT INTO mail.automatic_reply_configurations (
            id, short_id, mailbox_id, workflow_id, sender_identity_id,
            name, normalized_name, subject, body, format, ensure_reference, minimum_interval_hours,
            inactive_behavior, schedule_definition, enabled, created_by_actor_kind, created_by_actor_id
          ) VALUES (
            ${configurationId}::uuid,
            ${shortId},
            ${params.mailboxId}::uuid,
            ${workflowId}::uuid,
            ${senderIdentityId}::uuid,
            ${name},
            lower(regexp_replace(${name}, '\\s+', ' ', 'g')),
            ${automaticReply.subject},
            ${automaticReply.body},
            ${automaticReply.format},
            ${automaticReply.ensureReference},
            ${automaticReply.minimumIntervalHours},
            ${automaticReply.inactiveBehavior},
            ${schedule.data}::jsonb,
            ${automaticReply.enabled},
            ${actor.kind},
            ${actor.id}::uuid
          )
          RETURNING
            id, short_id, mailbox_id, workflow_id, sender_identity_id,
            name, subject, body, format, ensure_reference, minimum_interval_hours, inactive_behavior,
            enabled, revision, schedule_definition, created_at, updated_at
        `,
        );
        const [row] = rows;
        if (!row) throw new Error("Automatic reply insert returned no row");
        const configuration = unwrap(await mapConfiguration(row, tx));
        const activityId = await insertActivity({
          db: tx,
          context: params.context,
          configuration,
          configurationId,
          mailboxId: params.mailboxId,
          action: "automatic_reply_configuration.created",
        });
        await audit.record(
          {
            action: "mail.automatic_reply_configuration.create",
            outcome: "allowed",
            actor: auditActorFromRequest(params.context),
            target: { type: "automatic_reply_configuration", id: configurationId, label: name },
            requestId: params.context.requestId,
            metadata: { mailboxId: params.mailboxId, workflowId, enabled: automaticReply.enabled },
          },
          tx,
        );
        return {
          configuration,
          activityId,
          referenceConfiguration: referenceMutation?.configuration ?? null,
          referenceActivityId: referenceMutation?.activityId ?? null,
        };
      },
    );
    if (result.referenceActivityId) {
      await publishMailMailboxEvent({
        mailboxId: params.mailboxId,
        conversationId: null,
        reason: "reference_configuration",
        targetId: params.mailboxId,
        activityId: result.referenceActivityId,
      });
    }
    await publishMailMailboxEvent({
      mailboxId: params.mailboxId,
      conversationId: null,
      reason: "automatic_reply",
      targetId: result.configuration.id,
      activityId: result.activityId,
    });
    return ok({
      automaticReply: result.configuration,
      referenceConfiguration: result.referenceConfiguration,
    });
  } catch (error) {
    return mutationFailure(error, "Failed to create automatic reply");
  }
};

export const createAutomaticReplyConfiguration = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  input: CreateAutomaticReplyConfiguration;
}): Promise<Result<AutomaticReplyConfiguration>> => {
  const result = await createAutomaticReplySetup({
    ...params,
    input: { automaticReply: params.input },
  });
  return result.ok ? ok(result.data.automaticReply) : result;
};

export const updateAutomaticReplySetup = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  configurationId: string;
  input: UpdateAutomaticReplySetup;
}): Promise<Result<AutomaticReplySetup>> => {
  const parsed = internalUpdateAutomaticReplySetupSchema.safeParse(params.input);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid automatic reply"));
  const automaticReply = parsed.data.automaticReply;
  const schedule = validateManagedSchedule(automaticReply.schedule);
  if (!schedule.ok) return schedule;
  const name = normalizeName(automaticReply.name);
  try {
    const result = await sql.begin(
      async (
        tx,
      ): Promise<{
        configuration: AutomaticReplyConfiguration;
        activityId: string | null;
        referenceConfiguration: ConversationReferenceConfiguration | null;
        referenceActivityId: string | null;
      }> => {
        unwrap(await lockMailboxForAutomaticReply(params.context, params.mailboxId, tx));
        const current = unwrap(await loadConfiguration(params.mailboxId, params.configurationId, tx, true));
        const configurationId = params.configurationId;
        if (current.revision !== automaticReply.expectedRevision) {
          unwrap(fail(err.conflict("Automatic reply was changed")));
        }
        const changes = automaticReplyChanges(current, automaticReply, schedule.data, name);
        let workflowSenderIdentityId: string | null = null;
        if (automaticReply.enabled || changes.senderChanged) {
          workflowSenderIdentityId = unwrap(await requireAutomationSender(tx, params.mailboxId, automaticReply.senderIdentityId));
        }
        if (changes.executionChanged && !workflowSenderIdentityId) {
          workflowSenderIdentityId = unwrap(await senderWorkflowResourceId(tx, params.mailboxId, automaticReply.senderIdentityId));
        }
        const senderIdentityId = automaticReply.senderIdentityId;
        const referenceMutation = await putInlineReferenceConfiguration({
          context: params.context,
          mailboxId: params.mailboxId,
          input: parsed.data.referenceConfiguration,
          db: tx,
        });
        if (automaticReply.ensureReference && (automaticReply.enabled || !current.ensureReference)) {
          unwrap(await requireReferenceConfiguration(tx, params.mailboxId));
        }
        if (automaticReply.enabled) unwrap(await requireActivationAvailable(tx, params.mailboxId, params.configurationId));
        if (!changes.changed) {
          return {
            configuration: current,
            activityId: null,
            referenceConfiguration: referenceMutation?.configuration ?? null,
            referenceActivityId: referenceMutation?.activityId ?? null,
          };
        }

        await applyAutomaticReplyWorkflowUpdate({
          db: tx,
          context: params.context,
          mailboxId: params.mailboxId,
          configurationId: params.configurationId,
          current,
          input: automaticReply,
          schedule: schedule.data,
          executionChanged: changes.executionChanged,
          enabledChanged: changes.enabledChanged,
          workflowSenderIdentityId,
        });
        await tx`
          UPDATE mail.automatic_reply_configurations
          SET
            sender_identity_id = ${senderIdentityId}::uuid,
            name = ${name},
            normalized_name = lower(regexp_replace(${name}, '\\s+', ' ', 'g')),
            subject = ${automaticReply.subject},
            body = ${automaticReply.body},
            format = ${automaticReply.format},
            ensure_reference = ${automaticReply.ensureReference},
            minimum_interval_hours = ${automaticReply.minimumIntervalHours},
            inactive_behavior = ${automaticReply.inactiveBehavior},
            schedule_definition = ${schedule.data}::jsonb,
            enabled = ${automaticReply.enabled},
            revision = revision + 1
          WHERE id = ${params.configurationId}::uuid
            AND mailbox_id = ${params.mailboxId}::uuid
        `;
        const configuration = unwrap(await loadConfiguration(params.mailboxId, params.configurationId, tx));
        const activityId = await insertActivity({
          db: tx,
          context: params.context,
          configuration,
          configurationId,
          mailboxId: params.mailboxId,
          action: "automatic_reply_configuration.updated",
        });
        await audit.record(
          {
            action: "mail.automatic_reply_configuration.update",
            outcome: "allowed",
            actor: auditActorFromRequest(params.context),
            target: { type: "automatic_reply_configuration", id: params.configurationId, label: name },
            requestId: params.context.requestId,
            metadata: {
              mailboxId: params.mailboxId,
              workflowId: current.workflowId,
              enabled: automaticReply.enabled,
              revision: configuration.revision,
            },
          },
          tx,
        );
        return {
          configuration,
          activityId,
          referenceConfiguration: referenceMutation?.configuration ?? null,
          referenceActivityId: referenceMutation?.activityId ?? null,
        };
      },
    );
    if (result.referenceActivityId) {
      await publishMailMailboxEvent({
        mailboxId: params.mailboxId,
        conversationId: null,
        reason: "reference_configuration",
        targetId: params.mailboxId,
        activityId: result.referenceActivityId,
      });
    }
    if (result.activityId) {
      await publishMailMailboxEvent({
        mailboxId: params.mailboxId,
        conversationId: null,
        reason: "automatic_reply",
        targetId: result.configuration.id,
        activityId: result.activityId,
      });
    }
    return ok({
      automaticReply: result.configuration,
      referenceConfiguration: result.referenceConfiguration,
    });
  } catch (error) {
    return mutationFailure(error, "Failed to update automatic reply");
  }
};

export const updateAutomaticReplyConfiguration = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  configurationId: string;
  input: UpdateAutomaticReplyConfiguration;
}): Promise<Result<AutomaticReplyConfiguration>> => {
  const result = await updateAutomaticReplySetup({
    ...params,
    input: { automaticReply: params.input },
  });
  return result.ok ? ok(result.data.automaticReply) : result;
};
