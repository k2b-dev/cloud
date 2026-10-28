import { CloudResourceRefSchema } from "@k2b/cloud/contracts";
import { z } from "zod";
import { AttachmentViewSchema, AuthorSchema, MessageBodySchema, MessageIdSchema, ShortIdSchema } from "./service/contracts";

export const DISCUSSION_PAGE_SIZE = 20;
export const DISCUSSION_PREVIEW_LENGTH = 300;
export const DiscussionItemSchema = CloudResourceRefSchema.extend({
  type: z.enum(["spaces.item", "notebooks.note"]).describe("Owning item type; recurring events use the series item."),
  id: ShortIdSchema.describe("Item short ID returned by its owning application."),
}).describe("The exact Spaces item or Notebooks note whose Chat discussion to access.");
export const DiscussionListInputSchema = z.strictObject({
  item: DiscussionItemSchema,
  limit: z
    .number()
    .int()
    .min(1)
    .max(DISCUSSION_PAGE_SIZE)
    .default(DISCUSSION_PAGE_SIZE)
    .describe("Maximum newest-first previews, from 1 to 20."),
  cursor: z
    .string()
    .regex(/^[1-9][0-9]{0,15}$/)
    .optional()
    .describe("Opaque nextCursor returned by the previous discussion page."),
});
export const MessageReadInputSchema = z.strictObject({ id: MessageIdSchema.describe("Message ID from a chat.message resource ref.") });
export const DiscussionPostInputSchema = z.strictObject({
  item: DiscussionItemSchema,
  body: MessageBodySchema.describe("Markdown text, at most 20,000 Unicode characters, with non-whitespace content."),
  replyTo: MessageIdSchema.optional().describe("Message ID to reply to, within this same item discussion."),
});
export const MessageEditInputSchema = z.strictObject({
  id: MessageIdSchema.describe("Own message ID from a chat.message resource ref."),
  revision: z.number().int().nonnegative().describe("Content revision from the latest message.read; reactions do not change it."),
  body: MessageBodySchema.describe("Markdown text, at most 20,000 Unicode characters, with non-whitespace content."),
});
export const MessageDeleteInputSchema = MessageEditInputSchema.omit({ body: true });
export const DiscussionMessageSchema = z.strictObject({
  ref: CloudResourceRefSchema.extend({ type: z.literal("chat.message"), id: MessageIdSchema }),
  item: DiscussionItemSchema,
  author: AuthorSchema,
  createdAt: z.iso.datetime(),
  editedAt: z.iso.datetime().nullable(),
  deletedAt: z.iso.datetime().nullable(),
  revision: z.number().int().nonnegative(),
  via: z.enum(["assistant", "mcp"]).nullable(),
  replyTo: MessageIdSchema.nullable(),
});
export const DiscussionPreviewSchema = DiscussionMessageSchema.extend({ preview: z.string(), previewTruncated: z.boolean() });
export const DiscussionListDataSchema = z.array(DiscussionPreviewSchema).max(DISCUSSION_PAGE_SIZE);
export const DiscussionMessageDataSchema = DiscussionMessageSchema.extend({
  body: z.string().nullable(),
  refs: z.array(CloudResourceRefSchema).max(10),
  attachments: z.array(AttachmentViewSchema).max(10),
});
