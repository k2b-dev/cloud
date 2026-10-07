import { expect, spyOn, test } from "bun:test";
import { type AdminMailProfile, MailProfileInputSchema } from "../contracts/outgoing-mail";
import { OutgoingMailError, outgoingMailStore } from "../services/outgoing-mail/store";
import { outgoingMailTest } from "../services/outgoing-mail/test-send";
import { session } from "../services/session";
import { buildProjectedUser } from "../services/session/user";
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
