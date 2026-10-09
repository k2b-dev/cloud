import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  bindProcessApplicationId,
  clearProcessApplicationId,
  getProcessApplicationId,
  getProcessPlatformPermissions,
} from "../../_internal/process-identity";
import { MailFilterSchema, MailProfileInputSchema, MailProfileKeySchema } from "../../contracts/outgoing-mail";
import { mail } from "./index";
import { outgoingMailStore, resolveMailCredentials } from "./store";

const input = {
  name: "Alerts",
  fromAddress: "alerts@example.org",
  fromName: null,
  smtpHost: "smtp.example.org",
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: null,
  pacePerMinute: 60,
  dailyRecipientLimit: null,
  maxAttachmentBytes: 15728640,
};
let previousApplicationId: ReturnType<typeof getProcessApplicationId>;
let previousPermissions: ReturnType<typeof getProcessPlatformPermissions>;
beforeEach(() => {
  previousApplicationId = getProcessApplicationId();
  previousPermissions = getProcessPlatformPermissions();
  clearProcessApplicationId();
});
afterEach(() => {
  clearProcessApplicationId();
  if (previousApplicationId !== undefined) bindProcessApplicationId(previousApplicationId, previousPermissions);
});
test("profiles fail before startup and without a declared mail permission", async () => {
  expect(await mail.profiles()).toMatchObject({ ok: false, error: { code: "mail_unavailable" } });
  bindProcessApplicationId("inventory");
  expect(await mail.profiles()).toMatchObject({ ok: false, error: { code: "mail_not_declared" } });
});
test("profiles use the process identity and map database failures to mail_unavailable", async () => {
  bindProcessApplicationId("inventory", ["mail:send"]);
  const read = spyOn(outgoingMailStore, "profilesForApp").mockResolvedValue([]);
  try {
    expect(await mail.profiles()).toEqual({ ok: true, data: [] });
    expect(read).toHaveBeenCalledWith("inventory");
    read.mockRejectedValue(new Error("database credential must not escape"));
    expect(await mail.profiles()).toMatchObject({ ok: false, error: { code: "mail_unavailable" } });
    expect(JSON.stringify(await mail.profiles())).not.toContain("credential");
  } finally {
    read.mockRestore();
  }
});
test("profile contract rejects invalid keys, addresses and operational bounds", () => {
  expect(MailProfileInputSchema.safeParse(input).success).toBe(true);
  for (const change of [
    { fromAddress: "a\r\nBcc: x@example.org" },
    { smtpHost: "smtp://user:password@host" },
    { smtpPort: 0 },
    { smtpPort: 65536 },
    { pacePerMinute: 6001 },
    { pacePerMinute: 0 },
    { dailyRecipientLimit: 0 },
    { maxAttachmentBytes: 26214401 },
    { maxAttachmentBytes: 0 },
    { revision: 0 },
  ])
    expect(MailProfileInputSchema.safeParse({ ...input, ...change }).success).toBe(false);
  for (const key of ["UPPER", "-leading", "a".repeat(64), "a/b"]) expect(MailProfileKeySchema.safeParse(key).success).toBe(false);
});

test("platform send paths resolve profiles without a Core process identity or mail declaration", async () => {
  for (const appId of [undefined, "gateway-ops", "inventory"]) {
    clearProcessApplicationId();
    if (appId !== undefined) bindProcessApplicationId(appId);
    await expect(resolveMailCredentials("INVALID")).rejects.toMatchObject({ code: "invalid_profile" });
  }
});

test("send and list require startup and a process declaration", async () => {
  const { audit } = await import("../audit");
  const record = spyOn(audit, "record").mockResolvedValue();
  const message = { to: ["reader@example.org"], subject: "Hello", text: "Hello" };
  try {
    expect(await mail.send(message)).toMatchObject({ ok: false, error: { code: "mail_unavailable" } });
    expect(await mail.list()).toMatchObject({ ok: false, error: { code: "mail_unavailable" } });
    bindProcessApplicationId("inventory");
    expect(await mail.send(message)).toMatchObject({ ok: false, error: { code: "mail_not_declared" } });
    expect(await mail.list()).toMatchObject({ ok: false, error: { code: "mail_not_declared" } });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0]).toMatchObject({
      action: "outgoing_mail.send",
      outcome: "denied",
      metadata: { appId: "inventory", recipientCount: 1 },
    });
    expect(JSON.stringify(record.mock.calls)).not.toContain(message.to[0]!);
  } finally {
    record.mockRestore();
  }
});
test("list scopes every filter to the calling app and validates paging", async () => {
  const { outgoingMailMessages } = await import("./messages");
  bindProcessApplicationId("inventory", ["mail:send"]);
  const page = { items: [], page: 1, perPage: 20, total: 0, hasNext: false };
  const list = spyOn(outgoingMailMessages, "list").mockResolvedValue(page);
  try {
    expect(await mail.list({ ref: { scope: "order" }, status: ["failed"] }, { perPage: 20 })).toEqual({ ok: true, data: page });
    expect(list).toHaveBeenCalledWith(
      { apps: ["inventory"], recipientExact: undefined, ref: { scope: "order" }, status: ["failed"] },
      { perPage: 20 },
      false,
      "inventory",
    );
    expect(await mail.list({}, { perPage: 101 })).toMatchObject({ ok: false, error: { code: "bad_input" } });
    expect(list).toHaveBeenCalledTimes(1);
  } finally {
    list.mockRestore();
  }
});
test("send returns recorded outcomes and quota details without leaking infrastructure errors", async () => {
  const sendModule = await import("./send");
  const { audit } = await import("../audit");
  const { OutgoingMailError } = await import("./store");
  bindProcessApplicationId("inventory", ["mail:send"]);
  const record = {
    id: crypto.randomUUID(),
    appId: "inventory",
    profile: "alerts",
    to: ["reader@example.org"],
    subject: "Hello",
    status: "failed" as const,
    error: "550 mailbox unavailable",
    failures: [],
    attempts: 1,
    attachments: [],
    createdAt: new Date().toISOString(),
  };
  const send = spyOn(sendModule, "sendMail").mockResolvedValue(record);
  const recordAudit = spyOn(audit, "record").mockResolvedValue();
  const message = { to: record.to, subject: "Hello", text: "Hello" };
  try {
    expect(await mail.send(message)).toEqual({ ok: true, data: record });
    expect(send.mock.calls[0]?.[0]).toBe("inventory");
    send.mockRejectedValue(
      Object.assign(new OutgoingMailError("quota_exceeded", "Quota exhausted."), { limit: 10, used: 9, requested: 2 }),
    );
    expect(await mail.send(message)).toMatchObject({ ok: false, error: { code: "quota_exceeded", limit: 10, used: 9, requested: 2 } });
    send.mockRejectedValue(new Error("connection string secret"));
    expect(await mail.send(message)).toMatchObject({ ok: false, error: { code: "mail_unavailable" } });
    expect(JSON.stringify(await mail.send(message))).not.toContain("secret");
    expect(await mail.send({ ...message, headers: { Bcc: "spy@example.org" } })).toMatchObject({ ok: false, error: { code: "bad_input" } });
  } finally {
    send.mockRestore();
    recordAudit.mockRestore();
  }
});

test("mail:read-only apps list their own log but cannot use sender services", async () => {
  const { outgoingMailMessages } = await import("./messages");
  bindProcessApplicationId("reader", ["mail:read"]);
  const page = { items: [], page: 1, perPage: 50, total: 0, hasNext: false };
  const list = spyOn(outgoingMailMessages, "list").mockResolvedValue(page);
  const grants = spyOn(outgoingMailStore, "logAppsFor").mockResolvedValue(["source"]);
  const { audit } = await import("../audit");
  const record = spyOn(audit, "record").mockResolvedValue();
  try {
    expect(await mail.list()).toEqual({ ok: true, data: page });
    expect(list).toHaveBeenCalledWith({ apps: ["reader"], recipientExact: undefined }, {}, false, "reader");
    expect(grants).not.toHaveBeenCalled();
    expect(await mail.profiles()).toMatchObject({ ok: false, error: { code: "mail_not_declared", status: 403 } });
    const message = { to: ["a@example.org"], subject: "test", text: "body" };
    for (const result of [await mail.send(message), await mail.enqueue([message])])
      expect(result).toMatchObject({
        ok: false,
        error: { code: "mail_not_declared", message: 'Declare platformPermissions: ["mail:send"].', status: 403 },
      });
  } finally {
    for (const mock of [list, grants, record]) mock.mockRestore();
  }
});
test("other app logs require a declaration and current grants on every call", async () => {
  const { outgoingMailMessages } = await import("./messages");
  const page = { items: [], page: 1, perPage: 50, total: 0, hasNext: false };
  const list = spyOn(outgoingMailMessages, "list").mockResolvedValue(page);
  const grants = spyOn(outgoingMailStore, "logAppsFor").mockResolvedValue(["source"]);
  try {
    bindProcessApplicationId("reader", ["mail:send"]);
    expect(await mail.list({ apps: ["source"] })).toMatchObject({
      ok: false,
      error: { code: "mail_not_declared", message: expect.stringContaining('"mail:read"'), status: 403 },
    });
    expect(grants).not.toHaveBeenCalled();
    bindProcessApplicationId("reader", ["mail:read"]);
    expect(await mail.list({ apps: ["source", "denied"] })).toMatchObject({
      ok: false,
      error: { code: "app_not_allowed", message: expect.stringContaining("denied"), status: 403 },
    });
    expect(list).not.toHaveBeenCalled();
    expect(await mail.list({ apps: ["reader", "source"], recipient: " USER@example.org " })).toEqual({ ok: true, data: page });
    expect(list).toHaveBeenCalledWith({ apps: ["reader", "source"], recipientExact: "USER@example.org" }, {}, false, "reader");
    grants.mockResolvedValue([]);
    expect(await mail.list({ apps: ["source"] })).toMatchObject({ ok: false, error: { code: "app_not_allowed" } });
    expect(list).toHaveBeenCalledTimes(1);
    grants.mockRejectedValue(new Error("private connection string"));
    expect(await mail.list({ apps: ["source"] })).toMatchObject({ ok: false, error: { code: "mail_unavailable" } });
  } finally {
    list.mockRestore();
    grants.mockRestore();
  }
});
test("readableApps puts own app first, sorts grants, and requires a reading identity", async () => {
  const grants = spyOn(outgoingMailStore, "logAppsFor").mockResolvedValue(["zebra", "alpha"]);
  try {
    expect(await mail.readableApps()).toMatchObject({ ok: false, error: { code: "mail_unavailable" } });
    bindProcessApplicationId("reader");
    expect(await mail.readableApps()).toMatchObject({ ok: false, error: { code: "mail_not_declared" } });
    bindProcessApplicationId("reader", ["mail:send"]);
    expect(await mail.readableApps()).toEqual({ ok: true, data: ["reader"] });
    expect(grants).not.toHaveBeenCalled();
    bindProcessApplicationId("reader", ["mail:read"]);
    expect(await mail.readableApps()).toEqual({ ok: true, data: ["reader", "alpha", "zebra"] });
    grants.mockResolvedValue([]);
    expect(await mail.readableApps()).toEqual({ ok: true, data: ["reader"] });
    grants.mockRejectedValue(new Error("secret"));
    expect(await mail.readableApps()).toMatchObject({ ok: false, error: { code: "mail_unavailable" } });
    clearProcessApplicationId();
    // Core reads its own mail like any app; no grant can name Core as a reader or a source.
    bindProcessApplicationId("core", ["mail:read", "mail:send"]);
    grants.mockResolvedValue([]);
    expect(await mail.readableApps()).toEqual({ ok: true, data: ["core"] });
  } finally {
    grants.mockRestore();
  }
});
test("log filters bound and normalize search, app sets, recipients and timestamps", () => {
  expect(MailFilterSchema.parse({ q: "  AbC  ", recipient: " A@example.org " })).toEqual({ q: "AbC", recipient: "A@example.org" });
  for (const q of ["", "ab", "  ab ", "x".repeat(201), "abc\n", "\tabc", "ab\0c", "abc\x7f", "a\nbc"])
    expect(MailFilterSchema.safeParse({ q }).success).toBe(false);
  for (const apps of [[], ["reader", "reader"], ["bad/app"], ["UPPER"], Array.from({ length: 101 }, (_, i) => `app-${i}`)])
    expect(MailFilterSchema.safeParse({ apps }).success).toBe(false);
  expect(MailFilterSchema.safeParse({ apps: Array.from({ length: 100 }, (_, i) => `app-${i}`), q: "x".repeat(200) }).success).toBe(true);
  for (const until of ["yesterday", "2026-10-09", "2026-10-09T10:00:00", "2026-13-09T10:00:00Z"])
    expect(MailFilterSchema.safeParse({ until }).success).toBe(false);
  expect(MailFilterSchema.safeParse({ until: "2026-10-09T10:00:00+02:00" }).success).toBe(true);
  expect(MailFilterSchema.safeParse({ recipient: "@example.org" }).success).toBe(false);
});
