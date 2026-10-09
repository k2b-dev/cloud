import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { MailRecord } from "../../contracts/outgoing-mail";
import { type MessageRow, outgoingMailMessages } from "../outgoing-mail/messages";
import * as sender from "../outgoing-mail/send";
import { OutgoingMailError } from "../outgoing-mail/store";
import * as settings from "../settings";
import { coreSettings } from "../settings/api";
import { getNotificationChannel } from "./channels";

const id = "00000000-0000-4000-8000-000000000001";
const record: MailRecord = {
  appId: "core",
  id,
  profile: "default",
  to: ["reader@example.org"],
  subject: "Subject",
  attachments: [],
  status: "sent",
  failures: [],
  attempts: 1,
  createdAt: new Date().toISOString(),
};
const row: MessageRow = {
  id,
  app_id: "core",
  profile_id: null,
  profile_key: "default",
  batch_id: null,
  ref_scope: null,
  ref_id: null,
  to_addresses: record.to,
  recipient_count: 1,
  subject: record.subject,
  text_body: "Hello",
  html_body: "<p>Hello</p>",
  headers: null,
  from_name: null,
  reply_to: null,
  message_id_header: "<id@cloud.invalid>",
  attachments: [],
  attachment_refs: [],
  status: "sent",
  error_code: null,
  error_message: null,
  smtp_response: null,
  failures: [],
  attempt_count: 1,
  next_attempt_at: null,
  deadline_at: new Date(),
  actor_type: null,
  actor_id: null,
  actor_name: null,
  created_at: new Date(),
  cursor_created_at: new Date().toISOString(),
  sent_at: new Date(),
  content_purged_at: null,
};
let send: ReturnType<typeof spyOn<typeof sender, "sendMail">>;
let lookup: ReturnType<typeof spyOn<typeof outgoingMailMessages, "read">>;
let read: ReturnType<typeof spyOn<typeof settings, "get">>;
let logo: ReturnType<typeof spyOn<typeof coreSettings, "get">>;
beforeEach(() => {
  send = spyOn(sender, "sendMail").mockResolvedValue(record);
  lookup = spyOn(outgoingMailMessages, "read").mockResolvedValue(undefined);
  read = spyOn(settings, "get").mockResolvedValue("Cloud");
  logo = spyOn(coreSettings, "get").mockResolvedValue("");
});
afterEach(() => {
  for (const mock of [send, lookup, read, logo]) mock.mockRestore();
});
const deliver = () => {
  const driver = getNotificationChannel("email");
  if (!driver) throw new Error("Email driver missing");
  return driver.deliver({ to: "reader@example.org", subject: "Subject", content: "Hello" }, { deliveryId: id });
};
test("email uses Core's default profile, framed HTML, and a stable delivery key", async () => {
  expect(await deliver()).toEqual({ status: "delivered", outgoingMailId: id });
  const call = send.mock.calls[0];
  expect(call?.[0]).toBe("core");
  expect(call?.[1]).toMatchObject({ to: record.to, subject: "Subject", text: "Hello", key: `notification-delivery:${id}` });
  expect(call?.[1]).not.toHaveProperty("profile");
  expect(call?.[1].html).toContain("<!DOCTYPE html>");
  expect(call?.[3]).toEqual({ trustedHtml: true });
  await deliver();
  expect(send.mock.calls[1]?.[1].key).toBe(call?.[1].key);
});
test("email ignores the obsolete Message-ID in persisted notification payloads", async () => {
  await deliver();
  const driver = getNotificationChannel("email");
  if (!driver) throw new Error("Email driver missing");
  expect(
    await driver.deliver(
      { to: "reader@example.org", subject: "Subject", content: "Hello", messageId: "<cloud-notification-old@cloud.invalid>" },
      { deliveryId: id },
    ),
  ).toEqual({ status: "delivered", outgoingMailId: id });
  expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
  expect(send.mock.calls[1]?.[1]).not.toHaveProperty("messageId");
});

test("sent and bounced mail deliver; failed and cancelled mail fail without notification retries", async () => {
  for (const status of ["sent", "bounced"] as const) {
    send.mockResolvedValue({ ...record, status });
    expect(await deliver()).toEqual({ status: "delivered", outgoingMailId: id });
  }
  for (const status of ["failed", "cancelled"] as const) {
    send.mockResolvedValue({ ...record, status, error: "550 Rejected" });
    lookup.mockResolvedValue({ ...row, status, error_code: "smtp_failed", error_message: "550 Rejected" });
    await expect(deliver()).rejects.toMatchObject({ message: "550 Rejected", code: "smtp_failed", retryable: false, outgoingMailId: id });
  }
});
test("queued and sending mail stay pending with bounded polling and last SMTP error", async () => {
  for (const status of ["queued", "sending"] as const) {
    send.mockResolvedValue({ ...record, status });
    lookup.mockResolvedValue({
      ...row,
      status,
      next_attempt_at: new Date(Date.now() + 86_400_000),
      error_code: "smtp_failed",
      error_message: "451 Try again",
    });
    expect(await deliver()).toEqual({
      status: "pending",
      outgoingMailId: id,
      retryAfterMs: 300_000,
      errorMessage: "451 Try again",
    });
  }
  lookup.mockResolvedValue({ ...row, status: "queued", next_attempt_at: new Date(0) });
  expect(await deliver()).toMatchObject({ retryAfterMs: 2_000 });
});
test("mail availability and quota failures retry; policy failures terminate", async () => {
  for (const code of [
    "mail_unavailable",
    "quota_exceeded",
    "backlog_full",
    "profile_not_allowed",
    "profile_required",
    "profile_unknown",
    "mail_not_declared",
    "bad_input",
  ] as const) {
    send.mockRejectedValue(new OutgoingMailError(code, code));
    await expect(deliver()).rejects.toMatchObject({
      code,
      retryable: ["mail_unavailable", "quota_exceeded", "backlog_full"].includes(code),
    });
  }
});

test("recovery follows the stored mail ID and never reaccepts expired mail", async () => {
  const driver = getNotificationChannel("email");
  if (!driver) throw new Error("Email driver missing");
  lookup.mockResolvedValue(row);
  expect(await driver.deliver({}, { deliveryId: id, outgoingMailId: id })).toEqual({ status: "delivered", outgoingMailId: id });
  expect(send).not.toHaveBeenCalled();
  lookup.mockResolvedValue(undefined);
  await expect(driver.deliver({}, { deliveryId: id, outgoingMailId: id })).rejects.toMatchObject({
    message: "Outgoing mail record is no longer available.",
    code: "smtp_failed",
    retryable: false,
    outgoingMailId: id,
  });
  expect(send).not.toHaveBeenCalled();
});

test("notification email normalizes subject newlines and internationalized domains", async () => {
  const driver = getNotificationChannel("email");
  if (!driver) throw new Error("Email driver missing");
  await driver.deliver({ to: "user@müller.de", subject: "  Hello\r\nreader\0  ", content: "Hello" }, { deliveryId: id });
  expect(send.mock.calls[0]?.[1]).toMatchObject({ to: ["user@xn--mller-kva.de"], subject: "Hello reader" });
  await driver.deliver({ to: "reader@example.org", subject: "x".repeat(1000), content: "Hello" }, { deliveryId: id });
  expect(send.mock.calls[1]?.[1].subject).toHaveLength(998);
});
test("invalid notification email identifies the field without accepting mail", async () => {
  const driver = getNotificationChannel("email");
  if (!driver) throw new Error("Email driver missing");
  for (const to of ["a b@x.org", "a@x.org\n", "a@%78.org"]) {
    await expect(driver.deliver({ to, subject: "Subject", content: "Hello" }, { deliveryId: id })).rejects.toMatchObject({
      code: "bad_input",
      retryable: false,
      message: "Invalid notification email: to.0: Invalid email address",
    });
  }
  expect(send).not.toHaveBeenCalled();
});
