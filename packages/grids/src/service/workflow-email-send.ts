/**
 * Sending one workflow email, per recipient, exactly once.
 *
 * The step is idempotent as a whole, but its recipients are not one effect —
 * a run that dies after the second of five sends must not repeat those two.
 * So each recipient gets its own delivery intent, keyed by the run, the step
 * and the position; a replay finds the ones already settled and skips them.
 */
import type { WorkflowJsonValue } from "@valentinkolb/cloud/workflows";
import { sql } from "bun";
import { app } from "../config";
import type { EmailTemplate } from "../contracts";
import { createWorkflowNotificationSender } from "../notifications";
import { logAudit } from "./audit";
import { buildTemplateAppData, buildTemplateBusinessData } from "./documents";
import { renderEmailTemplate } from "./email-templates";
import { actionError, type GridsWorkflowActionScope, requireOk, workflowAuditMeta } from "./workflow-action-scope";
import {
  finishWorkflowEmailDeliveryIntent,
  getOrCreateWorkflowEmailDeliveryIntent,
  getWorkflowEmailDeliveryIntent,
  type WorkflowEmailDeliveryIntent,
} from "./workflow-email-deliveries";
import { workflowServiceText } from "./workflow-service-messages";

export type WorkflowEmailRecipient = { kind: "email" | "user"; value: string };

const notificationSender = createWorkflowNotificationSender(app.notifications);

/** Enough to identify a delivery in the audit log without storing the address. */
const recipientSummary = (kind: "email" | "user", value: string): string => {
  if (kind === "user") return `user:${value}`;
  const [name, domain] = value.split("@");
  return domain ? `${name?.slice(0, 2) ?? ""}***@${domain}` : "***";
};

const intentRecipient = (intent: WorkflowEmailDeliveryIntent, locale?: string) => {
  const recipient = intent.recipients[0];
  if (!recipient) throw actionError("WORKFLOW_EMAIL_INVALID", workflowServiceText(locale).emailRecipientMissing);
  return recipient;
};

export type SendWorkflowEmailInput = {
  scope: GridsWorkflowActionScope;
  template: EmailTemplate;
  recipients: WorkflowEmailRecipient[];
  data: Record<string, WorkflowJsonValue>;
  occurredAt: string;
  effectKey: string;
  workflowStepKey: string;
  locale?: string;
};

export const sendWorkflowEmail = async (input: SendWorkflowEmailInput): Promise<WorkflowJsonValue> => {
  const { scope, template } = input;
  const appData = await buildTemplateAppData();
  const rendered = requireOk(
    await renderEmailTemplate(template, {
      data: input.data,
      app: appData,
      business: await buildTemplateBusinessData(scope.baseId, appData),
      workflow: { id: scope.workflow.id, shortId: scope.workflow.shortId, name: scope.workflow.name },
      run: { id: scope.runId },
      date: { iso: input.occurredAt },
    }),
  );

  const intents: WorkflowEmailDeliveryIntent[] = [];
  for (const [recipientIndex, recipient] of input.recipients.entries()) {
    const index = recipientIndex + 1;
    const existing = await getWorkflowEmailDeliveryIntent(scope.runId, input.workflowStepKey, index);
    intents.push(
      existing ??
        (await getOrCreateWorkflowEmailDeliveryIntent({
          baseId: scope.baseId,
          workflowId: scope.workflow.id,
          workflowRunId: scope.runId,
          workflowStepKey: input.workflowStepKey,
          templateId: template.id,
          recipientIndex: index,
          recipientKind: recipient.kind,
          recipientValue: recipient.value,
          recipientSummary: recipientSummary(recipient.kind, recipient.value),
          idempotencyKey: `${input.effectKey}:recipient:${index}`,
          subject: rendered.subject,
          renderedHtml: rendered.html,
          locale: input.locale,
        })),
    );
  }

  const recipients: WorkflowJsonValue[] = [];
  for (const intent of intents) {
    const recipient = intentRecipient(intent, input.locale);
    if (intent.status !== "pending") {
      recipients.push({
        id: intent.notificationId ?? "",
        deliveryId: intent.id,
        kind: recipient.kind,
        recipient: recipient.recipient,
        status: intent.providerStatus ?? intent.status,
      });
      if (intent.status === "failed")
        throw actionError("WORKFLOW_EMAIL_FAILED", intent.error ?? workflowServiceText(input.locale).emailDeliveryFailed);
      continue;
    }
    if (!intent.recipientValue || !intent.subject || !intent.renderedHtml) {
      throw actionError("WORKFLOW_EMAIL_INVALID", workflowServiceText(input.locale).emailPendingIncomplete);
    }
    const sent = await notificationSender.send({
      kind: recipient.kind,
      recipient: intent.recipientValue,
      subject: intent.subject,
      html: intent.renderedHtml,
      locale: input.locale,
      idempotencyKey: intent.idempotencyKey,
      ...(scope.principal.userId ? { sentBy: scope.principal.userId } : {}),
    });
    const errorMessage = sent.status === "failed" ? (sent.error ?? workflowServiceText(input.locale).emailDeliveryFailed) : null;
    const delivery = await sql.begin(async (tx) => {
      const finished = await finishWorkflowEmailDeliveryIntent(
        intent.id,
        {
          notificationId: sent.id,
          providerStatus: sent.providerStatus,
          status: errorMessage ? "failed" : "sent",
          error: errorMessage,
        },
        tx,
        input.locale,
      );
      if (finished.transitioned) {
        await logAudit(
          {
            baseId: scope.baseId,
            userId: scope.principal.userId,
            action: errorMessage ? "workflow.email.failed" : sent.status === "queued" ? "workflow.email.queued" : "workflow.email.sent",
            diff: {
              workflowEmail: {
                old: null,
                new: {
                  ...workflowAuditMeta(scope),
                  templateId: template.id,
                  deliveryId: finished.delivery.id,
                  kind: recipient.kind,
                  recipient: recipient.recipient,
                  notificationId: sent.id,
                  status: sent.providerStatus,
                  ...(errorMessage ? { error: errorMessage } : { subject: intent.subject }),
                },
              },
            },
          },
          tx,
        );
      }
      return finished.delivery;
    });
    recipients.push({
      id: sent.id,
      deliveryId: delivery.id,
      kind: recipient.kind,
      recipient: recipient.recipient,
      status: sent.providerStatus,
    });
    if (errorMessage) throw actionError("WORKFLOW_EMAIL_FAILED", errorMessage);
  }

  return { templateId: template.id, subject: rendered.subject, recipients };
};
