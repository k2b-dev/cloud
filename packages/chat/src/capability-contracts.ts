import { CloudResourceRefSchema } from "@k2b/cloud/contracts";
import { z } from "zod";
import {
  AttachmentViewSchema,
  AuthorSchema,
  MAX_MESSAGE_REFS,
  MESSAGE_MAX_CODE_POINTS,
  MessageBodySchema,
  MessageIdSchema,
  MessageQuoteSchema,
} from "./service/contracts";

export const DISCUSSION_PAGE_SIZE = 20;
export const DISCUSSION_PREVIEW_LENGTH = 300;
export const DiscussionItemSchema = CloudResourceRefSchema.describe(
  "Exact ref of an item type declared by a provider's discussions role. IDs are opaque, at most 512 characters.",
);
export const DiscussionListInputSchema = z.strictObject({
  ref: DiscussionItemSchema,
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
  ref: DiscussionItemSchema,
  body: MessageBodySchema.describe("Markdown text, at most 20,000 Unicode characters, with non-whitespace content."),
  replyTo: MessageIdSchema.optional().describe("Message ID to reply to, within this same item discussion."),
  quotes: z
    .array(
      z.strictObject({
        message: MessageIdSchema.describe("ID of a message in this same item discussion."),
        text: z
          .string()
          .min(1)
          .max(MESSAGE_MAX_CODE_POINTS * 2)
          .describe(
            "The visible words of the message, without Markdown marks such as ** or link targets; spacing may differ. The stored quote is the message's own text in whole words.",
          ),
      }),
    )
    .max(MAX_MESSAGE_REFS)
    .optional()
    .describe("Passages of earlier messages this message answers, at most 10 and together at most 20,000 Unicode characters."),
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
/** A list names what a message quotes but not the words; message.read returns them, so a page keeps its bound. */
export const DiscussionPreviewSchema = DiscussionMessageSchema.extend({
  preview: z.string(),
  previewTruncated: z.boolean(),
  quotes: z
    .array(z.union([z.strictObject({ message: MessageIdSchema }), z.strictObject({ deleted: z.literal(true) })]))
    .max(MAX_MESSAGE_REFS)
    .describe(
      "Messages it quotes, without their words; message.read returns the passages. { deleted: true } once a quoted passage is gone.",
    ),
});
export const DiscussionListDataSchema = z.array(DiscussionPreviewSchema).max(DISCUSSION_PAGE_SIZE);
export const DiscussionMessageDataSchema = DiscussionMessageSchema.extend({
  body: z.string().nullable(),
  refs: z.array(CloudResourceRefSchema).max(10),
  attachments: z.array(AttachmentViewSchema).max(10),
  quotes: z
    .array(MessageQuoteSchema)
    .max(MAX_MESSAGE_REFS)
    .describe(
      "Passages of earlier messages it quotes, as they were when quoted; { deleted: true } once their message was deleted or changed so that the words are gone.",
    ),
});

/** Ordinary Chat messages share the complete content projection, with their conversation as location. */
export const ChatMessageDataSchema = DiscussionMessageDataSchema.omit({ item: true }).extend({
  conversation: z.strictObject({ type: z.literal("chat.conversation"), id: z.string().length(6) }),
  thread: z.string().length(6).nullable(),
});
export const MessageReadDataSchema = z.union([DiscussionMessageDataSchema, ChatMessageDataSchema]);
export const ConversationReadDataSchema = z.strictObject({
  view: z.strictObject({ title: z.string(), permission: z.enum(["read", "write", "admin"]) }),
});
