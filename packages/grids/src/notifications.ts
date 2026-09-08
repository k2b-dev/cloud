import { i18n } from "@k2b/stdlib";
import { type BoundNotificationMap, notification } from "@valentinkolb/cloud";
import { notifications } from "@valentinkolb/cloud/services";
import { z } from "zod";

const workflowEmailData = z.object({ subject: z.string(), html: z.string() });

const notificationMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: { sentByWorkflow: "Sent by a Grids workflow." },
    de: { sentByWorkflow: "Von einem Grids-Workflow gesendet." },
  },
});

export const NOTIFICATIONS = {
  workflowEmail: notification({
    recipient: "email",
    label: "Workflow emails",
    description: "Emails sent to an address by a Grids workflow.",
    presentation: {
      baseLocale: "en",
      translations: {
        de: {
          label: "Workflow-E-Mails",
          description: "E-Mails, die ein Grids-Workflow an eine Adresse sendet.",
        },
      },
    },
    delivery: { required: ["email"] },
    data: workflowEmailData,
    render: ({ subject }, { locale }) => ({ title: subject, body: notificationMessages.resolve([locale]).t.sentByWorkflow }),
    email: ({ subject, html }) => ({ subject, rawHtml: html }),
  }),
  workflowUserEmail: notification({
    recipient: "user",
    label: "Workflow emails to users",
    description: "Emails sent to a Cloud user by a Grids workflow.",
    presentation: {
      baseLocale: "en",
      translations: {
        de: {
          label: "Workflow-E-Mails an Cloud-Konten",
          description: "E-Mails, die ein Grids-Workflow an ein Cloud-Konto sendet.",
        },
      },
    },
    delivery: { required: ["email"] },
    data: workflowEmailData,
    render: ({ subject }, { locale }) => ({ title: subject, body: notificationMessages.resolve([locale]).t.sentByWorkflow }),
    email: ({ subject, html }) => ({ subject, rawHtml: html }),
  }),
};

type GridsNotificationDefinitions = BoundNotificationMap<"grids", typeof NOTIFICATIONS>;

type WorkflowNotificationSendInput = {
  kind: "email" | "user";
  recipient: string;
  subject: string;
  html: string;
  locale?: string;
  idempotencyKey: string;
  sentBy?: string;
};

type WorkflowNotificationSendResult = {
  id: string;
  status: "delivered" | "queued" | "failed";
  providerStatus: string;
  error?: string;
};

type WorkflowNotificationSender = {
  send: (input: WorkflowNotificationSendInput) => Promise<WorkflowNotificationSendResult>;
};

export const createWorkflowNotificationSender = (definitions: GridsNotificationDefinitions): WorkflowNotificationSender => ({
  send: async (input) => {
    const common = {
      data: { subject: input.subject, html: input.html },
      idempotencyKey: input.idempotencyKey,
      locale: input.locale,
      ...(input.sentBy ? { sentBy: input.sentBy } : {}),
    };
    const result =
      input.kind === "email"
        ? await notifications.send(definitions.workflowEmail, {
            ...common,
            recipient: { email: input.recipient },
          })
        : await notifications.send(definitions.workflowUserEmail, {
            ...common,
            recipient: { userId: input.recipient },
          });
    const failed = result.deliveries.find((delivery) => delivery.required && delivery.status === "failed");
    const status = result.status === "delivered" ? "delivered" : result.status === "queued" ? "queued" : "failed";
    return {
      id: result.id,
      status,
      providerStatus: result.status,
      ...(status === "failed" ? { error: failed?.errorCode ?? `email delivery ${result.status}` } : {}),
    };
  },
});
