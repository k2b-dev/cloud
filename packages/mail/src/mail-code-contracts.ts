import { CODE_EVENT_CATCHUP_LIMIT, CodeTestMockSchema } from "@k2b/cloud/code/events";
import { AppEventEnvelopeSchema } from "@k2b/cloud/contracts/app-events";
import { z } from "zod";
import { ResourceShortIdSchema } from "./contracts";

export const MailCodeSelectionInputSchema = z
  .object({
    folderId: ResourceShortIdSchema.optional().describe("Optional public folder ID within the mailbox."),
    from: z.iso.datetime({ offset: true }).optional().describe("Inclusive message date lower bound."),
    to: z.iso.datetime({ offset: true }).optional().describe("Exclusive message date upper bound."),
    cutoffAt: z.iso.datetime({ offset: true }).optional().describe("Original snapshot cutoff returned by the first page."),
    cursor: z
      .object({
        date: z.iso.datetime({ offset: true }).describe("Last selected message date."),
        id: z.uuid().describe("Last selected internal cursor identity."),
      })
      .strict()
      .optional()
      .describe("Opaque continuation returned by the previous page."),
  })
  .strict()
  .refine((input) => !input.from || !input.to || Date.parse(input.from) < Date.parse(input.to), "Start must precede end")
  .refine((input) => !input.cursor || !!input.cutoffAt, "A continuation needs its original cutoff");
export const MailCodeSelectionSchema = z
  .object({
    cutoffAt: z.iso.datetime({ offset: true }),
    items: z.array(z.object({ title: z.string().max(998), event: AppEventEnvelopeSchema }).strict()).max(CODE_EVENT_CATCHUP_LIMIT),
    nextCursor: z
      .object({
        date: z.iso.datetime({ offset: true }).describe("Last selected message date."),
        id: z.uuid().describe("Last selected internal cursor identity."),
      })
      .strict()
      .nullable(),
  })
  .strict();
export const MailCodePreviewInputSchema = z
  .object({ messageId: ResourceShortIdSchema.describe("Public message ID to preview within the mailbox.") })
  .strict();
export const MailCodePreviewSchema = z.object({ event: AppEventEnvelopeSchema, mock: CodeTestMockSchema }).strict();
