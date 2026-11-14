import { z } from "zod";

/** Evidence only: identifiers and restrictions in this format never confer access. */
export const mailAutomationExportEntrySchema = z.object({
  kind: z.literal("mail-workflow"),
  mailbox: z.object({ id: z.string(), name: z.string(), deletedAt: z.string().nullable(), aiCallsPerDay: z.number().int().nullable() }),
  workflow: z.object({
    id: z.string().uuid(),
    name: z.string(),
    description: z.string().nullable(),
    managedBy: z.enum(["incoming_automation", "automatic_reply"]).nullable(),
    enabled: z.boolean(),
    priority: z.number().int(),
    order: z.number().int(),
    currentVersionId: z.string().uuid(),
    activeVersionId: z.string().uuid().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  guidedDefinition: z
    .object({
      id: z.string(),
      revision: z.number().int(),
      name: z.string(),
      enabled: z.boolean(),
      scope: z.json(),
      steps: z.array(z.json()),
      deletedAt: z.string().nullable(),
    })
    .nullable(),
  automaticReply: z
    .object({
      id: z.string(),
      revision: z.number().int(),
      name: z.string(),
      enabled: z.boolean(),
      senderIdentityId: z.string(),
      subject: z.string(),
      body: z.string(),
      format: z.string(),
      ensureReference: z.boolean(),
      minimumIntervalHours: z.number(),
      inactiveBehavior: z.string(),
      schedule: z.json(),
    })
    .nullable(),
  mandateSummary: z
    .object({
      id: z.string().uuid(),
      state: z.string(),
      revision: z.number().int(),
      expiresAt: z.string().nullable(),
      apps: z.json(),
      operations: z.json(),
      actions: z.string(),
    })
    .nullable(),
  version: z.object({
    id: z.string().uuid(),
    revision: z.number().int(),
    source: z.string(),
    sourceHash: z.string(),
    languageId: z.string(),
    languageVersion: z.number().int(),
    manifestHash: z.string(),
    bindings: z.record(z.string(), z.json()),
    effectBudget: z.record(z.string(), z.json()),
    createdAt: z.string(),
  }),
  activations: z.array(
    z.object({
      id: z.string().uuid(),
      versionId: z.string().uuid(),
      key: z.string(),
      eventType: z.string(),
      config: z.json(),
      enabled: z.boolean(),
    }),
  ),
});
export type MailAutomationExportEntry = z.infer<typeof mailAutomationExportEntrySchema>;
export const mailAutomationExportPageSchema = z.object({
  format: z.literal("cloud.mail-automation"),
  version: z.literal(1),
  authority: z.literal("none"),
  scope: z.enum(["mailbox", "installation"]),
  exportedAt: z.string(),
  items: z.array(mailAutomationExportEntrySchema),
  nextCursor: z.string().uuid().nullable(),
});
export type MailAutomationExportPage = z.infer<typeof mailAutomationExportPageSchema>;
// A page contains one full version: reply bodies can be 2 MiB before JSON escaping.
// Do not multiply that payload by the ordinary list page size.
export const mailAutomationExportQuerySchema = z
  .object({
    after: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(1).default(1),
  })
  .strict();
