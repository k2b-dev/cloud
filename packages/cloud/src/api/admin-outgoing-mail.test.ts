import { expect, spyOn, test } from "bun:test";
import { SQL, sql } from "bun";
import { type AdminMailProfile, MailProfileInputSchema, MailRetentionSchema } from "../contracts/outgoing-mail";
import { audit } from "../services/audit";
import { OutgoingMailError, outgoingMailStore } from "../services/outgoing-mail/store";
import { outgoingMailTest } from "../services/outgoing-mail/test-send";
import { session } from "../services/session";
import { buildProjectedUser } from "../services/session/user";
import * as settings from "../services/settings";
import settingsRoutes from "./admin-core-settings";
import { createAdminOutgoingMailRoutes } from "./admin-outgoing-mail";

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
const profile: AdminMailProfile = {
  ...input,
  key: "alerts",
  hasPassword: true,
  isDefault: true,
  revision: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  updatedBy: null,
  appCount: 1,
};
const user = buildProjectedUser({ id: crypto.randomUUID(), provider: "local", profile: "user", effective_admin: true });
const authorized = () =>
  createAdminOutgoingMailRoutes(async (c, next) => {
    c.set("user", user);
    await next();
  });
const request = (app: ReturnType<typeof authorized>, path: string, method: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test("every outgoing mail route requires administrator authentication", async () => {
  const app = createAdminOutgoingMailRoutes();
  for (const [path, method] of [
    ["/retention", "GET"],
    ["/retention", "PUT"],
    ["/messages", "GET"],
    [`/messages/${crypto.randomUUID()}`, "GET"],
    [`/messages/${crypto.randomUUID()}/content`, "GET"],
    [`/messages/${crypto.randomUUID()}/cancel`, "POST"],
    [`/batches/${crypto.randomUUID()}/cancel`, "POST"],
    ["/profiles", "GET"],
    ["/profiles/alerts", "GET"],
    ["/profiles/alerts", "PUT"],
    ["/profiles/alerts", "DELETE"],
    ["/profiles/alerts/default", "POST"],
    ["/profiles/alerts/test", "POST"],
    ["/apps", "GET"],
    ["/apps/inventory", "PUT"],
  ]) {
    expect((await request(app, path!, method!, {})).status).toBe(401);
  }
});
test("retention reads effective settings even when record deletion precedes content purge", async () => {
  const get = spyOn(settings, "get").mockResolvedValueOnce(90).mockResolvedValueOnce(30);
  try {
    const response = await authorized().request("/retention");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ contentDays: 90, recordDays: 30 });
    expect(get.mock.calls).toEqual([["outgoing_mail.content_retention_days"], ["outgoing_mail.record_retention_days"]]);
  } finally {
    get.mockRestore();
  }
});
test("retention PUT rejects incomplete, non-integer, non-positive, reversed and extra input before writing", async () => {
  const set = spyOn(settings, "set");
  const record = spyOn(audit, "record");
  try {
    for (const input of [
      {},
      { contentDays: 30 },
      { recordDays: 90 },
      { contentDays: 0, recordDays: 90 },
      { contentDays: 30, recordDays: -1 },
      { contentDays: 1.5, recordDays: 90 },
      { contentDays: 30, recordDays: 90.5 },
      { contentDays: 90, recordDays: 36501 },
      { contentDays: 36501, recordDays: 36501 },
      { contentDays: "30", recordDays: 90 },
      { contentDays: 90, recordDays: 30 },
      { contentDays: 30, recordDays: 90, extra: true },
    ]) {
      const response = await request(authorized(), "/retention", "PUT", input);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "bad_input", message: expect.any(String) });
    }
    const reversed = await request(authorized(), "/retention", "PUT", { contentDays: 90, recordDays: 30 });
    expect(await reversed.json()).toMatchObject({ message: expect.stringContaining("at least content retention") });
    expect(set).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  } finally {
    set.mockRestore();
    record.mockRestore();
  }
});
test("retention schema accepts at most 36500 whole days", () => {
  expect(MailRetentionSchema.safeParse({ contentDays: 36500, recordDays: 36500 }).success).toBe(true);
});
test("retention PUT writes both settings and the old/new audit in one transaction, then invalidates cache", async () => {
  const get = spyOn(settings, "get").mockResolvedValueOnce(90).mockResolvedValueOnce(365);
  const set = spyOn(settings, "set").mockResolvedValue();
  const record = spyOn(audit, "record").mockResolvedValue();
  const invalidate = spyOn(settings, "invalidateSettingsCache").mockResolvedValue();
  // Lazy, unused connection: all writers are mocked; nothing queries this client.
  const tx = Object.assign(new SQL("postgres://localhost/unused_test"), {
    savepoint: () => {
      throw new Error("Unexpected savepoint");
    },
  });
  const begin = spyOn(sql, "begin").mockImplementation(async (run) => {
    if (typeof run !== "function") throw new Error("Expected transaction callback");
    await run(tx);
    expect(invalidate).not.toHaveBeenCalled();
  });
  try {
    const next = { contentDays: 30, recordDays: 30 };
    const response = await request(authorized(), "/retention", "PUT", next);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(next);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(set.mock.calls).toEqual([
      ["outgoing_mail.content_retention_days", 30, tx],
      ["outgoing_mail.record_retention_days", 30, tx],
    ]);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]).toEqual([
      expect.objectContaining({
        action: "outgoing_mail.retention.update",
        actor: expect.objectContaining({ userId: user.id }),
        metadata: { old: { contentDays: 90, recordDays: 365 }, new: next },
      }),
      tx,
    ]);
    expect(invalidate).toHaveBeenCalledWith(["outgoing_mail.content_retention_days", "outgoing_mail.record_retention_days"]);
  } finally {
    for (const mock of [get, set, record, invalidate, begin]) mock.mockRestore();
  }
});
test("PUT validates and reports create/replace status without credentials", async () => {
  const app = authorized();
  const put = spyOn(outgoingMailStore, "put").mockResolvedValue({ profile, created: true });
  try {
    const created = await request(app, "/profiles/alerts", "PUT", { ...input, smtpPassword: "not-returned" });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual(profile);
    expect(put.mock.calls[0]?.[2]).toMatchObject({ actor: { userId: user.id } });
    put.mockResolvedValue({ profile: { ...profile, revision: 2 }, created: false });
    expect((await request(app, "/profiles/alerts", "PUT", { ...input, revision: 1 })).status).toBe(200);
    for (const change of [{ smtpPort: 0 }, { fromAddress: "invalid" }, { maxAttachmentBytes: 26214401 }]) {
      const response = await request(app, "/profiles/alerts", "PUT", { ...input, ...change, smtpPassword: "not-returned" });
      expect(response.status).toBe(400);
      const issue = MailProfileInputSchema.safeParse({ ...input, ...change }).error?.issues[0];
      expect(await response.json()).toEqual({ code: "invalid_profile", message: `${issue?.path.join(".")}: ${issue?.message}` });
    }
    const invalidKey = await request(app, "/profiles/INVALID", "PUT", input);
    expect(invalidKey.status).toBe(400);
    expect(await invalidKey.json()).toMatchObject({ code: "invalid_profile", message: expect.stringContaining("key:") });
    expect(put).toHaveBeenCalledTimes(2);
    for (const code of ["revision_conflict", "profile_exists"] as const) {
      put.mockRejectedValue(new OutgoingMailError(code, "Conflict", 409));
      const response = await request(app, "/profiles/alerts", "PUT", input);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code });
    }
  } finally {
    put.mockRestore();
  }
});
test("validation reports only the first issue without echoing submitted secrets", async () => {
  const response = await request(authorized(), "/profiles/alerts", "PUT", {
    ...input,
    smtpPort: 0,
    pacePerMinute: 0,
    smtpPassword: { secret: "must-not-escape" },
  });
  expect(response.status).toBe(400);
  const body = await response.json();
  expect(body.code).toBe("invalid_profile");
  expect(body.message).toStartWith("smtpPort:");
  expect(body.message).not.toContain("pacePerMinute");
  expect(JSON.stringify(body)).not.toContain("must-not-escape");
  const passwordError = await request(authorized(), "/profiles/alerts", "PUT", {
    ...input,
    smtpPassword: { secret: "must-not-escape" },
  });
  expect(passwordError.status).toBe(400);
  const passwordBody = await passwordError.json();
  expect(passwordBody.message).toContain("smtpPassword:");
  expect(JSON.stringify(passwordBody)).not.toContain("must-not-escape");
});
test("profile text limits reject oversized fields without echoing values and accept the maxima", async () => {
  const maximum = {
    name: "n".repeat(120),
    fromName: "f".repeat(120),
    fromAddress: `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.${"e".repeat(63)}`,
    smtpHost: "h".repeat(253),
    smtpUser: "u".repeat(320),
    smtpPassword: "p".repeat(16384),
  };
  const put = spyOn(outgoingMailStore, "put").mockResolvedValue({ profile, created: true });
  try {
    for (const [field, value] of Object.entries(maximum)) {
      const submitted = field === "fromAddress" ? value.replace("@", "a@") : `${value}x`;
      const response = await request(authorized(), "/profiles/alerts", "PUT", { ...input, [field]: submitted });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.code).toBe("invalid_profile");
      expect(body.message).toStartWith(`${field}:`);
      expect(JSON.stringify(body)).not.toContain(submitted);
    }
    expect(put).not.toHaveBeenCalled();
    expect((await request(authorized(), "/profiles/alerts", "PUT", { ...input, ...maximum })).status).toBe(201);
    expect(put).toHaveBeenCalledTimes(1);
  } finally {
    put.mockRestore();
  }
});
test("Core access policies are rejected by the real store without an audit record", async () => {
  const { audit } = await import("../services/audit");
  const record = spyOn(audit, "record");
  try {
    for (const policy of [{ mode: "default" }, { mode: "selected", profiles: ["alerts"] }, { mode: "selected", profiles: [] }]) {
      const response = await request(authorized(), "/apps/core", "PUT", policy);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "invalid_profile",
        message: "Core's system email always uses the default profile.",
      });
    }
    expect(record).not.toHaveBeenCalled();
  } finally {
    record.mockRestore();
  }
});
test("profile read, default, delete and test endpoints preserve the admin contract", async () => {
  const app = authorized();
  const list = spyOn(outgoingMailStore, "list").mockResolvedValue([profile]);
  const get = spyOn(outgoingMailStore, "get").mockResolvedValue(profile);
  const set = spyOn(outgoingMailStore, "setDefault").mockResolvedValue(profile);
  const del = spyOn(outgoingMailStore, "delete").mockResolvedValue();
  const send = spyOn(outgoingMailTest, "send").mockResolvedValue();
  try {
    expect(await (await app.request("/profiles")).json()).toEqual({ items: [profile] });
    expect(await (await app.request("/profiles/alerts")).json()).toEqual(profile);
    expect((await request(app, "/profiles/alerts/default", "POST")).status).toBe(200);
    expect((await request(app, "/profiles/alerts", "DELETE")).status).toBe(204);
    del.mockRejectedValue(new OutgoingMailError("profile_is_default", "Default", 409));
    expect((await request(app, "/profiles/alerts", "DELETE")).status).toBe(409);
    get.mockRejectedValue(new OutgoingMailError("profile_unknown", "Unknown", 404));
    expect((await app.request("/profiles/unknown")).status).toBe(404);
    expect(await (await request(app, "/profiles/alerts/test", "POST", { recipient: "test@example.org" })).json()).toEqual({ ok: true });
    expect((await request(app, "/profiles/alerts/test", "POST", { recipient: "invalid" })).status).toBe(400);
    send.mockRejectedValue(new OutgoingMailError("smtp_failed", "550 Mailbox unavailable", 502));
    const failed = await request(app, "/profiles/alerts/test", "POST", { recipient: "test@example.org" });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ code: "smtp_failed", message: "550 Mailbox unavailable" });
  } finally {
    for (const mock of [list, get, set, del, send]) mock.mockRestore();
  }
});
test("application access accepts default and empty selected policies, rejects unknown keys", async () => {
  const app = authorized();
  const item = { appId: "inventory", name: "Inventory", registered: true, declared: true, mode: "selected" as const, profiles: [] };
  const list = spyOn(outgoingMailStore, "apps").mockResolvedValue({ defaultProfile: "alerts", items: [item] });
  const set = spyOn(outgoingMailStore, "setAppAccess").mockResolvedValue(item);
  try {
    expect(await (await app.request("/apps")).json()).toEqual({ defaultProfile: "alerts", items: [item] });
    for (const policy of [{ mode: "default" }, { mode: "selected", profiles: [] }, { mode: "selected", profiles: ["alerts"] }])
      expect((await request(app, "/apps/inventory", "PUT", policy)).status).toBe(200);
    for (const policy of [{ mode: "selected" }, { mode: "default", profiles: ["alerts"] }, { mode: "other" }])
      expect((await request(app, "/apps/inventory", "PUT", policy)).status).toBe(400);
    set.mockRejectedValue(new OutgoingMailError("profile_unknown", "Unknown profile"));
    const response = await request(app, "/apps/inventory", "PUT", { mode: "selected", profiles: ["unknown"] });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "profile_unknown" });
  } finally {
    list.mockRestore();
    set.mockRestore();
  }
});

test("the settings SMTP test route is removed", async () => {
  expect((await settingsRoutes.request("/test-email", { method: "POST" })).status).toBe(404);
});

test("authenticated non-admins cannot read or mutate outgoing mail", async () => {
  const nonAdmin = buildProjectedUser({ id: crypto.randomUUID(), provider: "local", profile: "user", effective_admin: false });
  const authenticate = spyOn(session, "authenticateRequest").mockResolvedValue({
    user: nonAdmin,
    data: { userId: nonAdmin.id, sid: "test", authEpoch: 0, kind: "web", expiresAt: new Date(Date.now() + 60000).toISOString() },
  });
  const app = createAdminOutgoingMailRoutes();
  try {
    for (const [path, method] of [
      ["/messages", "GET"],
      [`/messages/${crypto.randomUUID()}`, "GET"],
      [`/messages/${crypto.randomUUID()}/content`, "GET"],
      [`/messages/${crypto.randomUUID()}/cancel`, "POST"],
      [`/batches/${crypto.randomUUID()}/cancel`, "POST"],
      ["/profiles", "GET"],
      ["/profiles/alerts", "GET"],
      ["/profiles/alerts", "PUT"],
      ["/profiles/alerts", "DELETE"],
      ["/profiles/alerts/default", "POST"],
      ["/profiles/alerts/test", "POST"],
      ["/apps", "GET"],
      ["/apps/inventory", "PUT"],
    ]) {
      expect((await app.request(path!, { method, headers: { Cookie: "session_token=test", Accept: "application/json" } })).status).toBe(
        403,
      );
    }
  } finally {
    authenticate.mockRestore();
  }
});

test("batch cancellation validates its UUID, preserves admin context, and returns unknown batches as 404", async () => {
  const { outgoingMailLog } = await import("../services/outgoing-mail/admin");
  const batchId = crypto.randomUUID();
  const cancel = spyOn(outgoingMailLog, "cancelBatch").mockResolvedValue({ batchId, cancelled: 2 });
  try {
    const response = await request(authorized(), `/batches/${batchId}/cancel`, "POST");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ batchId, cancelled: 2 });
    expect(cancel.mock.calls[0]).toEqual([batchId, expect.objectContaining({ actor: expect.objectContaining({ userId: user.id }) })]);
    expect((await request(authorized(), "/batches/invalid/cancel", "POST")).status).toBe(400);
    expect(cancel).toHaveBeenCalledTimes(1);
    cancel.mockRejectedValue(new OutgoingMailError("batch_unknown", "Unknown batch.", 404));
    const unknown = await request(authorized(), `/batches/${batchId}/cancel`, "POST");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ code: "batch_unknown" });
  } finally {
    cancel.mockRestore();
  }
});
test("send-log routes validate filters, return metadata and forward audited content/cancellation context", async () => {
  const { outgoingMailLog } = await import("../services/outgoing-mail/admin");
  const id = crypto.randomUUID();
  const metadata = {
    id,
    appId: "inventory",
    profile: "alerts",
    to: ["reader@example.org"],
    subject: "Hello",
    attachments: [],
    status: "queued" as const,
    failures: [],
    attempts: 0,
    createdAt: "2026-10-07T00:00:00.000Z",
  };
  const page = { items: [metadata], page: 1, perPage: 20, total: 1, hasNext: false };
  const list = spyOn(outgoingMailLog, "list").mockResolvedValue(page);
  const get = spyOn(outgoingMailLog, "get").mockResolvedValue(metadata);
  const content = spyOn(outgoingMailLog, "content").mockResolvedValue({ purged: false, text: "Hello", html: null, headers: null });
  const cancel = spyOn(outgoingMailLog, "cancel").mockResolvedValue({ ...metadata, status: "cancelled" });
  try {
    const app = authorized();
    const response = await app.request(
      "/messages?app=inventory&profile=alerts&status=queued&status=failed&ref=order:42&recipient=%40example.org&limit=20&cursor=abc",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(page);
    expect(list).toHaveBeenCalledWith(
      { app: "inventory", profile: "alerts", status: ["queued", "failed"], ref: { scope: "order", id: "42" }, recipient: "@example.org" },
      { perPage: 20, cursor: "abc" },
    );
    expect(await (await app.request(`/messages/${id}`)).json()).toEqual(metadata);
    expect(await (await app.request(`/messages/${id}/content`)).json()).toMatchObject({ text: "Hello" });
    expect(content.mock.calls[0]?.[1]).toMatchObject({ actor: { userId: user.id } });
    expect((await request(app, `/messages/${id}/cancel`, "POST")).status).toBe(200);
    expect(cancel.mock.calls[0]?.[1]).toMatchObject({ actor: { userId: user.id } });
    cancel.mockRejectedValue(new OutgoingMailError("message_not_queued", "Only queued mail can be cancelled.", 409));
    const conflict = await request(app, `/messages/${id}/cancel`, "POST");
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "message_not_queued" });
    for (const path of [
      "/messages?limit=101",
      "/messages?status=unknown",
      "/messages?since=yesterday",
      "/messages?ref=:id",
      "/messages/not-a-uuid",
    ])
      expect((await app.request(path)).status).toBe(400);
    for (const ref of ["x".repeat(201), `order:${"x".repeat(201)}`, `${"x".repeat(201)}:42`]) {
      const response = await app.request(`/messages?ref=${ref}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "bad_input" });
    }
    expect(list).toHaveBeenCalledTimes(1);
  } finally {
    for (const mock of [list, get, content, cancel]) mock.mockRestore();
  }
});
