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

test("custom header byte limits include names and separators", () => {
  expect(MailMessageSchema.safeParse({ ...message, subject: "x".repeat(998), headers: { "X-A": "x".repeat(8185) } }).success).toBe(true);
  expect(MailMessageSchema.safeParse({ ...message, headers: { "X-A": "x".repeat(8186) } }).success).toBe(false);
});
