import { expect, test } from "bun:test";
import { MailErrorCodeSchema, MailFilterSchema, MailMessageSchema } from "../../contracts/outgoing-mail";
import { mailBackoffMs, mailEnvelope, mailMessageId } from "./message";

const message = { to: ["reader@example.org"], subject: "Hello", text: "Plain text" };
test("mail input enforces recipients, UTF-8 body sizes, and header injection protection", () => {
  expect(MailMessageSchema.safeParse(message).success).toBe(true);
  for (const change of [
    { to: [] },
    { to: Array(51).fill("reader@example.org") },
    { to: ["invalid"] },
    { subject: "x".repeat(999) },
    { subject: "Hello\r\nBcc: spy@example.org" },
    { text: "é".repeat(262145) },
    { html: "x".repeat(524289) },
    { fromName: "Sender\nBcc: spy@example.org" },
    { replyTo: "invalid" },
    { key: "x".repeat(201) },
    { headers: { "X-Foo": "bar\r\nbaz" } },
  ])
    expect(MailMessageSchema.safeParse({ ...message, ...change }).success).toBe(false);
  expect(MailMessageSchema.safeParse({ ...message, to: Array(50).fill("reader@example.org"), text: "x".repeat(524288) }).success).toBe(
    true,
  );
});
test("headers use a case-insensitive allow-list and an 8 KiB aggregate bound", () => {
  for (const name of [
    "X-App",
    "X-App_ID",
    "X-App.Id",
    "x-app",
    "List-Id",
    "List-Unsubscribe",
    "List-Unsubscribe-Post",
    "In-Reply-To",
    "References",
    "Auto-Submitted",
    "Precedence",
  ])
    expect(MailMessageSchema.safeParse({ ...message, headers: { [name]: "value" } }).success).toBe(true);
  for (const name of ["X-Cloud-Trace", "x-CLOUD-secret", "From", "To", "Bcc", "Subject", "Message-ID", "Content-Type", "X-A\nB"])
    expect(MailMessageSchema.safeParse({ ...message, headers: { [name]: "value" } }).success).toBe(false);
  expect(MailMessageSchema.safeParse({ ...message, headers: { "X-A": "é".repeat(4096) } }).success).toBe(false);
});
test("message and filter references are bounded to 200 characters per part", () => {
  for (const ref of [
    { scope: "order", id: "x".repeat(201) },
    { scope: "x".repeat(201), id: "42" },
  ]) {
    expect(MailMessageSchema.safeParse({ ...message, ref }).success).toBe(false);
    expect(MailFilterSchema.safeParse({ ref }).success).toBe(false);
  }
  const ref = { scope: "x".repeat(200), id: "x".repeat(200) };
  expect(MailMessageSchema.safeParse({ ...message, ref }).success).toBe(true);
  expect(MailFilterSchema.safeParse({ ref }).success).toBe(true);
});
test("messages allow at most 20 attachments", () => {
  const attachment = { filename: "empty.txt", contentType: "text/plain", content: new Uint8Array() };
  expect(MailMessageSchema.safeParse({ ...message, attachments: Array(21).fill(attachment) }).success).toBe(false);
  expect(MailMessageSchema.safeParse({ ...message, attachments: Array(20).fill(attachment) }).success).toBe(true);
});
test("mail error and filter contracts cover acceptance, delivery, and bounded log reads", () => {
  for (const code of [
    "bad_input",
    "profile_not_allowed",
    "profile_required",
    "quota_exceeded",
    "attachments_too_large",
    "attachment_storage_full",
    "profile_removed",
    "attachment_lost",
    "cancelled_by_admin",
  ])
    expect(MailErrorCodeSchema.safeParse(code).success).toBe(true);
  expect(MailFilterSchema.safeParse({ ids: Array(101).fill(crypto.randomUUID()) }).success).toBe(false);
  expect(MailFilterSchema.safeParse({ since: "yesterday" }).success).toBe(false);
});
test("SMTP identity uses the profile address, registered app name and fixed Message-ID", () => {
  const profile = { fromAddress: "alerts@example.org", fromName: null };
  expect(mailMessageId("abc", profile.fromAddress)).toBe("<abc@example.org>");
  expect(mailEnvelope(profile, "Inventory")).toEqual({
    from: { address: "alerts@example.org", name: "Inventory" },
    envelope: { from: "alerts@example.org" },
  });
  expect(mailEnvelope({ ...profile, fromName: "Profile" }, "Inventory", "Override").from.name).toBe("Override");
  expect(mailEnvelope({ ...profile, fromName: "Profile" }, "Inventory").from.name).toBe("Profile");
});
test("SMTP backoff doubles from one minute and caps at one hour", () => {
  expect([1, 2, 3, 6, 7, 1000].map(mailBackoffMs)).toEqual([60000, 120000, 240000, 1920000, 3600000, 3600000]);
});

test("NUL characters and duplicate custom header names are rejected before Postgres", () => {
  for (const change of [
    { text: "nul\0" },
    { html: "nul\0" },
    { key: "nul\0" },
    { ref: { scope: "order", id: "nul\0" } },
    { headers: { "X-App": "one", "x-app": "two" } },
  ])
    expect(MailMessageSchema.safeParse({ ...message, ...change }).success).toBe(false);
});

test("SMTP failures distinguish permanent responses from retryable connection and temporary errors", async () => {
  const { smtpRetryable } = await import("./dispatcher");
  expect(smtpRetryable(Object.assign(new Error("451"), { responseCode: 451 }))).toBe(true);
  expect(smtpRetryable(Object.assign(new Error("550"), { responseCode: 550 }))).toBe(false);
  expect(smtpRetryable(new Error("Connection lost"))).toBe(true);
});
test("all-rejected SMTP errors retry any temporary recipient regardless of order", async () => {
  const { smtpRetryable } = await import("./dispatcher");
  for (const codes of [
    [451, 550],
    [550, 451],
    [550, 553],
  ]) {
    const error = Object.assign(new Error("All recipients were rejected"), {
      responseCode: codes.at(-1),
      rejectedErrors: codes.map((responseCode) => ({ responseCode })),
    });
    expect(smtpRetryable(error)).toBe(codes.includes(451));
  }
});

test("custom header byte limits include names and separators", () => {
  expect(MailMessageSchema.safeParse({ ...message, subject: "x".repeat(998), headers: { "X-A": "x".repeat(8185) } }).success).toBe(true);
  expect(MailMessageSchema.safeParse({ ...message, headers: { "X-A": "x".repeat(8186) } }).success).toBe(false);
});

test("recipient and reply-to addresses use HTML email syntax", () => {
  for (const address of ["user@example.xn--p1ai", "a&b@example.org", "admin@intranet"]) {
    expect(MailMessageSchema.safeParse({ ...message, to: [address], replyTo: address }).success).toBe(true);
  }
  for (const address of ["a b@x.org", '\"q\"@x.org', "a@x.org\n", "<a@x.org>", "a,b@x.org", "user@müller.de"]) {
    expect(MailMessageSchema.safeParse({ ...message, to: [address] }).success).toBe(false);
    expect(MailMessageSchema.safeParse({ ...message, replyTo: address }).success).toBe(false);
  }
});
