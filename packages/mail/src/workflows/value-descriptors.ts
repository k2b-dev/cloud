import type { WorkflowValuePathDescriptor } from "@k2b/cloud/workflows/language";

export const textValue: WorkflowValuePathDescriptor = { kind: "scalar", type: "core.text" };
const numberValue: WorkflowValuePathDescriptor = { kind: "scalar", type: "core.number" };
export const booleanValue: WorkflowValuePathDescriptor = { kind: "scalar", type: "core.boolean" };
export const dateTimeValue: WorkflowValuePathDescriptor = { kind: "scalar", type: "core.dateTime" };
const textArrayValue: WorkflowValuePathDescriptor = { kind: "array", type: "core.textArray", items: textValue };
const referenceResult: WorkflowValuePathDescriptor = {
  kind: "object",
  type: "mail.reference",
  properties: {
    value: textValue,
    created: booleanValue,
    conversationId: textValue,
    conversationRevision: { kind: "scalar", type: "core.number" },
  },
};
const draftResult: WorkflowValuePathDescriptor = {
  kind: "object",
  type: "mail.draft",
  properties: {
    id: textValue,
    revision: { kind: "scalar", type: "core.number" },
    senderIdentityId: textValue,
    deliveryClass: textValue,
  },
};
const mailAddress: WorkflowValuePathDescriptor = {
  kind: "object",
  type: "mail.address",
  properties: { role: textValue, name: textValue, email: textValue },
};
const mailAttachment: WorkflowValuePathDescriptor = {
  kind: "object",
  type: "mail.attachment",
  properties: {
    id: textValue,
    filename: textValue,
    contentType: textValue,
    disposition: textValue,
    contentId: textValue,
    sizeBytes: { kind: "scalar", type: "core.number" },
  },
};
export const mailValueDescriptors: Record<string, WorkflowValuePathDescriptor> = {
  "mail.message": {
    kind: "object",
    type: "mail.message",
    properties: {
      id: textValue,
      conversationId: textValue,
      subject: textValue,
      sender: { kind: "array", type: "core.array", items: mailAddress },
      fromAddress: textValue,
      fromDomain: textValue,
      recipients: { kind: "array", type: "core.array", items: mailAddress },
      body: textValue,
      bodyText: textValue,
      bodyHtml: textValue,
      attachments: { kind: "array", type: "core.array", items: mailAttachment },
      hasAttachments: booleanValue,
      textLength: numberValue,
      attachmentCount: numberValue,
      isBulk: booleanValue,
      folderId: textValue,
      flags: { kind: "array", type: "core.array", items: textValue },
      keywords: { kind: "array", type: "core.array", items: textValue },
      direction: textValue,
      internalDate: dateTimeValue,
      receivedAt: dateTimeValue,
    },
  },
  "mail.conversation": {
    kind: "object",
    type: "mail.conversation",
    properties: {
      id: textValue,
      subject: textValue,
      summary: textValue,
      summaryRevision: { kind: "scalar", type: "core.number" },
      assigneeUserIds: { kind: "array", type: "core.array", items: textValue },
      workStatus: textValue,
      latestMessageAt: dateTimeValue,
      messageCount: numberValue,
    },
  },
  "mail.context": {
    kind: "object",
    type: "mail.context",
    properties: {
      mailboxId: textValue,
      actor: {
        kind: "object",
        type: "workflow.actor",
        properties: {
          userId: textValue,
          groupIds: { kind: "array", type: "core.array", items: textValue },
          serviceAccountId: textValue,
        },
      },
      occurredAt: dateTimeValue,
    },
  },
  "core.textArray": textArrayValue,
  "mail.reference": referenceResult,
  "mail.draft": draftResult,
};
