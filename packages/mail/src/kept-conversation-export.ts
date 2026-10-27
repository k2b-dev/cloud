import { z } from "zod";
import { SHORT_ID_REGEX } from "./lib/short-id";

const publicId = z.string().regex(SHORT_ID_REGEX);
const address = z.object({
  name: z.string().nullable().describe("Stored sender or recipient display name, if available."),
  address: z.string().describe("Stored email address."),
});
/** Portable evidence export. It contains stored bodies and attachment metadata, never attachment bytes or raw MIME. */
export const KeptConversationExportSchema = z.object({
  schema: z.literal("cloud.mail.kept-conversations/v1").describe("Version of this JSON export contract."),
  exportedAt: z.iso.datetime().describe("UTC time at which the export was prepared."),
  exportedBy: z
    .object({ label: z.string().describe("Display name, uid, or service account name of the exporting principal.") })
    .describe("Principal who requested this export."),
  conversations: z
    .array(
      z.object({
        cloudId: z
          .string()
          .regex(/^[0-9A-Za-z]{6}\/[0-9A-Za-z]{6}$/)
          .describe("Mailbox public ID/conversation public ID."),
        mailbox: z
          .object({
            id: publicId.describe("Public mailbox ID, including for a soft-deleted mailbox."),
            name: z.string().describe("Current stored mailbox name."),
          })
          .describe("Mailbox that owns the conversation."),
        conversationId: publicId.describe("Mailbox-scoped public conversation ID."),
        subject: z.string().nullable().describe("Stored conversation subject."),
        keep: z
          .object({
            keptAt: z.iso.datetime().describe("UTC time at which the keep was set."),
            keptBy: z
              .object({
                kind: z.enum(["user", "service_account", "workflow", "system"]).describe("Kind of principal who set the keep."),
                displayName: z.string().describe("Keeper's current display name or a former-principal fallback."),
              })
              .describe("Original keeper; internal principal IDs are omitted."),
          })
          .describe("Keep present when the export was prepared."),
        messages: z
          .array(
            z.object({
              id: publicId.describe("Public message ID."),
              messageId: z.string().nullable().describe("Stored RFC Message-ID header, if available."),
              delivery: z
                .object({
                  state: z
                    .enum([
                      "scheduled",
                      "undo_window",
                      "sending",
                      "accepted",
                      "sent_sync_pending",
                      "sent",
                      "failed",
                      "cancelled",
                      "unknown",
                      "reconciled_accepted",
                      "reconciled_unsent",
                      "needs_attention",
                    ])
                    .describe("Stored delivery state; cancelled or scheduled messages must not be treated as delivered."),
                })
                .nullable()
                .describe("Outbound delivery metadata, or null for messages without a Cloud outbox submission."),
              date: z.iso.datetime().describe("Stored sent date, falling back to the provider's internal date."),
              from: z.array(address).describe("Stored From addresses in header order."),
              replyTo: z.array(address).describe("Stored Reply-To addresses in header order."),
              to: z.array(address).describe("Stored To recipients in header order."),
              cc: z.array(address).describe("Stored Cc recipients in header order."),
              bcc: z.array(address).describe("Stored Bcc recipients, when known to Mail."),
              subject: z.string().nullable().describe("Stored message subject."),
              inReplyTo: z.string().nullable().describe("Stored In-Reply-To header."),
              references: z.array(z.string()).describe("Stored References header Message-IDs."),
              headers: z.record(z.string(), z.unknown()).describe("Selected header subset stored by Mail; not the complete raw headers."),
              text: z.string().nullable().describe("Stored plain text body; null if not hydrated."),
              html: z.string().nullable().describe("Sanitized HTML body stored by Mail; null if unavailable."),
              attachments: z
                .array(
                  z.object({
                    id: publicId.describe("Public attachment ID."),
                    filename: z.string().nullable().describe("Stored filename, if provided."),
                    contentType: z.string().describe("Stored MIME content type."),
                    size: z.number().int().nonnegative().describe("Attachment size in bytes; bytes themselves are excluded."),
                    inline: z.boolean().describe("Whether the stored Content-Disposition is inline."),
                    contentId: z.string().nullable().describe("Stored Content-ID, if available."),
                  }),
                )
                .describe("Attachment metadata only, without blob identifiers or contents."),
            }),
          )
          .describe("Stored messages in conversation position and message ID order."),
      }),
    )
    .describe("Requested kept conversations; a detail response contains exactly one."),
});
export type KeptConversationExport = z.infer<typeof KeptConversationExportSchema>;
