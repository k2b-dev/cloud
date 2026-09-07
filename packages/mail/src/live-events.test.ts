import { describe, expect, test } from "bun:test";
import {
  MAIL_LIVE_WS_TYPE,
  MailLiveClientMessageSchema,
  type MailLiveServerMessage,
  MailLiveServerMessageSchema,
  parseMailLiveServerMessage,
} from "./live-events";

const MAILBOX_ID = "Box001";
const CONVERSATION_ID = "Conv01";
const INTERNAL_UUID = "1da425e0-6bea-47ee-95a4-9d2151802171";

describe("Mail live protocol", () => {
  test("validates subscribe cursors and rejects unknown client messages", () => {
    expect(
      MailLiveClientMessageSchema.safeParse({
        type: MAIL_LIVE_WS_TYPE.subscribe,
        payload: { mailboxId: MAILBOX_ID, fromCursor: "s6t.mailtest.124" },
      }).success,
    ).toBeTrue();
    expect(
      MailLiveClientMessageSchema.safeParse({
        type: MAIL_LIVE_WS_TYPE.subscribe,
        payload: { mailboxId: MAILBOX_ID, fromCursor: "" },
      }).success,
    ).toBeFalse();
    expect(MailLiveClientMessageSchema.safeParse({ type: "mail.live.legacy", payload: {} }).success).toBeFalse();
    expect(
      MailLiveClientMessageSchema.safeParse({
        type: MAIL_LIVE_WS_TYPE.subscribe,
        payload: { mailboxId: INTERNAL_UUID, fromCursor: null },
      }).success,
    ).toBeFalse();
  });

  test("parses every server message variant through one discriminated union", () => {
    const event = {
      type: MAIL_LIVE_WS_TYPE.event,
      payload: {
        mailboxId: MAILBOX_ID,
        cursor: "s6t.mailtest.131",
        event: {
          type: "mail.invalidated",
          mailboxId: MAILBOX_ID,
          conversationId: CONVERSATION_ID,
          changeId: "14f26be3-77e9-4756-b19b-3e9d88e940dd",
          at: "2026-07-16T20:00:00.000Z",
        },
      },
    } satisfies MailLiveServerMessage;
    const messages = [
      { type: MAIL_LIVE_WS_TYPE.ready, payload: { mailboxId: MAILBOX_ID, cursor: "s6t.mailtest.124" } },
      event,
      {
        type: MAIL_LIVE_WS_TYPE.revoked,
        payload: { mailboxId: MAILBOX_ID, code: "access_denied", message: "Access denied" },
      },
      {
        type: MAIL_LIVE_WS_TYPE.error,
        payload: { mailboxId: MAILBOX_ID, code: "stream_failed", message: "Stream failed" },
      },
    ];

    for (const message of messages) expect(MailLiveServerMessageSchema.safeParse(message).success).toBeTrue();
    expect(parseMailLiveServerMessage(JSON.stringify(event))).toEqual(event);
    expect(
      MailLiveServerMessageSchema.safeParse({
        type: MAIL_LIVE_WS_TYPE.event,
        payload: {
          mailboxId: MAILBOX_ID,
          cursor: "s6t.mailtest.141",
          event: {
            type: "mail.invalidated",
            mailboxId: MAILBOX_ID,
            conversationId: null,
            changeId: "f695501f-58c6-45d8-a078-ae06ed28bc7f",
            at: "2026-07-16T20:01:00.000Z",
          },
        },
      }).success,
    ).toBeTrue();
    expect(parseMailLiveServerMessage("not-json")).toBeNull();
    expect(parseMailLiveServerMessage(JSON.stringify({ type: MAIL_LIVE_WS_TYPE.event, payload: {} }))).toBeNull();
  });
});
