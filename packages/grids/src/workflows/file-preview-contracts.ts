import { z } from "zod";

export const WorkflowFileReferenceSchema = z
  .object({
    kind: z.literal("fileSnapshot"),
    id: z.uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    rowCount: z.number().int().nonnegative(),
    capturedAt: z.iso.datetime(),
  })
  .strict();
// A capture is a view of one durable step, not another public resource.
// The owning run is addressed by Short ID; stepKey identifies its capture.
export const PublicWorkflowFileReferenceSchema = WorkflowFileReferenceSchema.omit({ id: true }).extend({ stepKey: z.string().min(1) });
export type WorkflowFileReference = z.infer<typeof PublicWorkflowFileReferenceSchema>;

export const WorkflowFilePreviewSchema = z.object({
  filename: z.string(),
  format: z.literal("camt.052.001.08"),
  messageId: z.string(),
  createdAt: z.string(),
  capturedAt: z.string(),
  pagination: z.object({ pageNumber: z.string(), lastPage: z.boolean() }).nullable(),
  reports: z.array(
    z.object({
      id: z.string(),
      account: z.string(),
      currency: z.string().nullable(),
      period: z.object({ from: z.string(), to: z.string() }).nullable(),
      pagination: z.object({ pageNumber: z.string(), lastPage: z.boolean() }).nullable(),
      entryCount: z.number().int().nonnegative(),
      statuses: z.record(z.string(), z.number().int().nonnegative()),
      details: z.json(),
    }),
  ),
});
export type WorkflowFilePreview = z.infer<typeof WorkflowFilePreviewSchema>;

export const workflowFileReferenceFromOutcome = (outcome: unknown): WorkflowFileReference | null => {
  const parsed = z.object({ state: z.literal("succeeded"), output: PublicWorkflowFileReferenceSchema }).safeParse(outcome);
  return parsed.success ? parsed.data.output : null;
};
