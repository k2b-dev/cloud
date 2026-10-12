import { CloudResourceRefSchema } from "@k2b/cloud/contracts";
import { z } from "zod";
import { ResourceShortIdSchema } from "./contracts";

export const MailComposeCommandInputSchema = z
  .object({
    contact: CloudResourceRefSchema.optional().describe(
      "Optional contact from Mail's configured contact directory, such as a contacts.contact ref, to read and choose a recipient from.",
    ),
  })
  .strict();
export const MailDraftCalendarInputSchema = z
  .object({
    mailboxId: ResourceShortIdSchema.describe("Public mailbox ID."),
    draftId: ResourceShortIdSchema.describe("Public ID of the existing draft to keep and edit."),
  })
  .strict();
export { mailCommandMessages } from "./command-messages";
