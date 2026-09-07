import { z } from "zod";

const MailResourceIdSchema = z.string().regex(/^[0-9A-Za-z]{6}$/);

export const MAIL_LIVE_WS_TYPE = {
  subscribe: "mail.live.subscribe",
  ready: "mail.live.ready",
  event: "mail.live.event",
  revoked: "mail.live.revoked",
  error: "mail.live.error",
} as const;

export const MailInvalidationSchema = z
  .object({
    type: z.literal("mail.invalidated"),
    mailboxId: MailResourceIdSchema,
    conversationId: MailResourceIdSchema.nullable(),
    changeId: z.uuid(),
    at: z.string().datetime(),
  })
  .strict();

export type MailInvalidation = z.infer<typeof MailInvalidationSchema>;

export const MailLiveCursorSchema = z.string().min(1).max(512);
const MailLiveRevocationCodeSchema = z.enum(["login_required", "not_found", "access_denied"]);
const MailLiveErrorCodeSchema = z.enum(["invalid_json", "invalid_message", "backpressure", "internal_error", "stream_failed"]);

export type MailLiveRevocationCode = z.infer<typeof MailLiveRevocationCodeSchema>;
export type MailLiveErrorCode = z.infer<typeof MailLiveErrorCodeSchema>;

const MailLiveSubscribeMessageSchema = z
  .object({
    type: z.literal(MAIL_LIVE_WS_TYPE.subscribe),
    payload: z
      .object({
        mailboxId: MailResourceIdSchema,
        fromCursor: MailLiveCursorSchema.nullable(),
      })
      .strict(),
  })
  .strict();

export const MailLiveClientMessageSchema = z.discriminatedUnion("type", [MailLiveSubscribeMessageSchema]);
export type MailLiveClientMessage = z.infer<typeof MailLiveClientMessageSchema>;

export const MailLiveServerMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal(MAIL_LIVE_WS_TYPE.ready),
      payload: z.object({ mailboxId: MailResourceIdSchema, cursor: MailLiveCursorSchema }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal(MAIL_LIVE_WS_TYPE.event),
      payload: z.object({ mailboxId: MailResourceIdSchema, cursor: MailLiveCursorSchema, event: MailInvalidationSchema }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal(MAIL_LIVE_WS_TYPE.revoked),
      payload: z
        .object({
          mailboxId: MailResourceIdSchema,
          code: MailLiveRevocationCodeSchema,
          message: z.string().min(1).max(500),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal(MAIL_LIVE_WS_TYPE.error),
      payload: z
        .object({
          mailboxId: MailResourceIdSchema.optional(),
          code: MailLiveErrorCodeSchema,
          message: z.string().min(1).max(500),
        })
        .strict(),
    })
    .strict(),
]);

export type MailLiveServerMessage = z.infer<typeof MailLiveServerMessageSchema>;

export const parseMailLiveServerMessage = (raw: string): MailLiveServerMessage | null => {
  try {
    const parsed = MailLiveServerMessageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};
