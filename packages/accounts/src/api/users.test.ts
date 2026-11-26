import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import { AppApprovalError, accountsAppService, appApproval, notifications, PwaError, pwaDevices } from "@k2b/cloud/services";
import { type AuthenticatedSession, session } from "@k2b/cloud/services/session";
import users from "./users";

const adminId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";
const admin: User = {
  id: adminId,
  uid: "admin",
  provider: "local",
  profile: "user",
  roles: ["admin"],
  givenname: "Test",
  sn: "Admin",
  displayName: "Test Admin",
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};
const token = spyOn(session, "getToken").mockReturnValue("test-session");
const authenticate = spyOn(session, "authenticateRequest").mockResolvedValue({
  user: admin,
  data: { userId: adminId, sid: "test-session", authEpoch: 0, kind: "web", expiresAt: "2099-01-01T00:00:00Z" },
});
const remove = spyOn(accountsAppService.user, "remove");
afterEach(() => remove.mockReset());
afterAll(() => {
  token.mockRestore();
  authenticate.mockRestore();
  remove.mockRestore();
});
const del = () => users.request(`/${targetId}`, { method: "DELETE" });

test("deleting a local user answers with the documented JSON message", async () => {
  remove.mockResolvedValue({ ok: true, data: undefined });
  const res = await del();
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/json");
  expect(await res.json()).toEqual({ message: "User permanently deleted" });
  expect(remove).toHaveBeenCalledWith({ id: targetId, actor: expect.objectContaining({ userId: adminId, uid: "admin" }) });
});

test("service errors keep the JSON error contract", async () => {
  remove.mockResolvedValue({ ok: false, error: "User not found", status: 404 } as never);
  const res = await del();
  expect(res.status).toBe(404);
  expect(res.headers.get("content-type")).toContain("application/json");
  expect(await res.json()).toMatchObject({ message: "User not found" });
});

const deviceId = "33333333-3333-4333-8333-333333333333";
const device = {
  id: deviceId,
  name: "Lost phone",
  createdAt: "2026-09-01T10:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
  assisted: true,
};
const minimalTarget = { id: targetId, uid: "ada", provider: "local", profile: "user", storedAdmin: false };

test("device routes need admin authority before reaching the device service", async () => {
  const list = spyOn(appApproval, "listUserDevices");
  const revoke = spyOn(appApproval, "revokeUserDevice");
  authenticate.mockResolvedValueOnce({
    user: { ...admin, roles: [] },
    data: { userId: adminId, sid: "test-session", authEpoch: 0, kind: "web", expiresAt: "2099-01-01T00:00:00Z" },
  });
  authenticate.mockResolvedValueOnce({
    user: { ...admin, roles: [] },
    data: { userId: adminId, sid: "test-session", authEpoch: 0, kind: "web", expiresAt: "2099-01-01T00:00:00Z" },
  });
  try {
    expect((await users.request(`/${targetId}/devices`)).status).toBe(403);
    expect((await users.request(`/${targetId}/devices/${deviceId}`, { method: "DELETE" })).status).toBe(403);
    expect(list).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  } finally {
    list.mockRestore();
    revoke.mockRestore();
  }
});

test("admins list a user's devices through the device service", async () => {
  const getMinimal = spyOn(accountsAppService.user, "getMinimal").mockResolvedValue(minimalTarget as never);
  const list = spyOn(appApproval, "listUserDevices").mockResolvedValue([device]);
  try {
    const res = await users.request(`/${targetId}/devices`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ devices: [device] });
    expect(list).toHaveBeenCalledWith({ userId: adminId, admin: true }, targetId);
    getMinimal.mockResolvedValue(null);
    expect((await users.request(`/${targetId}/devices`)).status).toBe(404);
  } finally {
    getMinimal.mockRestore();
    list.mockRestore();
  }
});

test("revoking notifies the user once and repeats succeed without another notice", async () => {
  const getMinimal = spyOn(accountsAppService.user, "getMinimal").mockResolvedValue(minimalTarget as never);
  const revoke = spyOn(appApproval, "revokeUserDevice")
    .mockResolvedValueOnce({ device: { ...device, revokedAt: "2026-09-27T10:00:00.000Z" }, revoked: true })
    .mockResolvedValueOnce({ device: { ...device, revokedAt: "2026-09-27T10:00:00.000Z" }, revoked: false });
  const send = spyOn(notifications, "send").mockResolvedValue({ id: "event", status: "queued" } as never);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await users.request(`/${targetId}/devices/${deviceId}`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Device revoked." });
    }
    expect(revoke).toHaveBeenCalledWith({ userId: adminId, admin: true }, targetId, deviceId);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ id: "accounts.deviceRevoked" }),
      expect.objectContaining({
        recipient: { userId: targetId },
        data: { name: "Lost phone" },
        idempotencyKey: `device-revoked:${deviceId}`,
        sentBy: adminId,
      }),
    );
  } finally {
    getMinimal.mockRestore();
    revoke.mockRestore();
    send.mockRestore();
  }
});

test("a failed notice keeps the committed revocation, and unknown devices answer 404", async () => {
  const getMinimal = spyOn(accountsAppService.user, "getMinimal").mockResolvedValue(minimalTarget as never);
  const revoke = spyOn(appApproval, "revokeUserDevice")
    .mockResolvedValueOnce({ device, revoked: true })
    .mockRejectedValueOnce(new AppApprovalError("UNAVAILABLE", 404));
  const send = spyOn(notifications, "send").mockRejectedValue(new Error("offline"));
  try {
    expect((await users.request(`/${targetId}/devices/${deviceId}`, { method: "DELETE" })).status).toBe(200);
    const missing = await users.request(`/${targetId}/devices/${deviceId}`, { method: "DELETE" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ message: "Device not found" });
  } finally {
    getMinimal.mockRestore();
    revoke.mockRestore();
    send.mockRestore();
  }
});

test("an invalid app sign-in configuration answers 503 on both device routes", async () => {
  const getMinimal = spyOn(accountsAppService.user, "getMinimal").mockResolvedValue(minimalTarget as never);
  const list = spyOn(appApproval, "listUserDevices").mockRejectedValue(new AppApprovalError("UNAVAILABLE", 503));
  const revoke = spyOn(appApproval, "revokeUserDevice").mockRejectedValue(new AppApprovalError("UNAVAILABLE", 503));
  try {
    for (const res of [
      await users.request(`/${targetId}/devices`),
      await users.request(`/${targetId}/devices/${deviceId}`, { method: "DELETE" }),
    ]) {
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ code: "UNAVAILABLE", message: "App sign-in is unavailable" });
    }
  } finally {
    getMinimal.mockRestore();
    list.mockRestore();
    revoke.mockRestore();
  }
});

const phone = {
  id: deviceId,
  name: "Ada's iPhone",
  platform: "ios" as const,
  createdAt: "2026-09-01T10:00:00.000Z",
  lastUsedAt: "2026-09-30T08:00:00.000Z",
  current: false,
};

test("app device routes need admin authority; an administrator's app session carries none", async () => {
  const list = spyOn(pwaDevices, "listUserDevices");
  const revoke = spyOn(pwaDevices, "revokeUserDevice");
  // A web session without the role, and an administrator's app session as the session layer delivers it.
  const sessions: AuthenticatedSession[] = [
    { user: { ...admin, roles: [] }, data: { userId: adminId, sid: "web", authEpoch: 0, kind: "web", expiresAt: "2099-01-01T00:00:00Z" } },
    {
      user: { ...admin, roles: [] },
      data: { userId: adminId, sid: "app", authEpoch: 0, kind: "app", deviceId, expiresAt: "2099-01-01T00:00:00Z" },
    },
  ];
  try {
    for (const authenticated of sessions) {
      authenticate.mockResolvedValueOnce(authenticated);
      authenticate.mockResolvedValueOnce(authenticated);
      expect((await users.request(`/${targetId}/app-devices`)).status).toBe(403);
      expect((await users.request(`/${targetId}/app-devices/${deviceId}`, { method: "DELETE" })).status).toBe(403);
    }
    expect(list).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  } finally {
    list.mockRestore();
    revoke.mockRestore();
  }
});

test("admins list a user's phones and removal repeats without error", async () => {
  const getMinimal = spyOn(accountsAppService.user, "getMinimal").mockResolvedValue(minimalTarget as never);
  const list = spyOn(pwaDevices, "listUserDevices").mockResolvedValue([phone]);
  const revoke = spyOn(pwaDevices, "revokeUserDevice").mockResolvedValueOnce({ revoked: true }).mockResolvedValueOnce({ revoked: false });
  const send = spyOn(notifications, "send");
  try {
    const listed = await users.request(`/${targetId}/app-devices`);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ devices: [phone] });
    expect(list).toHaveBeenCalledWith({ userId: adminId, admin: true }, targetId);

    for (const revoked of [true, false]) {
      const res = await users.request(`/${targetId}/app-devices/${deviceId}`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ revoked });
    }
    expect(revoke).toHaveBeenCalledWith({ userId: adminId, admin: true }, targetId, deviceId);
    // No removal notice in the preview.
    expect(send).not.toHaveBeenCalled();
  } finally {
    getMinimal.mockRestore();
    list.mockRestore();
    revoke.mockRestore();
    send.mockRestore();
  }
});

test("unknown users and phones answer 404 in the Accounts error format", async () => {
  const getMinimal = spyOn(accountsAppService.user, "getMinimal").mockResolvedValue(minimalTarget as never);
  const revoke = spyOn(pwaDevices, "revokeUserDevice").mockRejectedValue(new PwaError("NOT_FOUND", 404));
  try {
    const missing = await users.request(`/${targetId}/app-devices/${deviceId}`, { method: "DELETE" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ message: "Device not found" });
    getMinimal.mockResolvedValue(null);
    expect((await users.request(`/${targetId}/app-devices`)).status).toBe(404);
    expect((await users.request(`/${targetId}/app-devices/${deviceId}`, { method: "DELETE" })).status).toBe(404);
    expect(revoke).toHaveBeenCalledTimes(1);
  } finally {
    getMinimal.mockRestore();
    revoke.mockRestore();
  }
});

const create = spyOn(accountsAppService.user, "create");
const update = spyOn(accountsAppService.user, "update");
afterEach(() => {
  create.mockReset();
  update.mockReset();
});
afterAll(() => {
  create.mockRestore();
  update.mockRestore();
});
const post = (body: Record<string, unknown>) =>
  users.request("/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const person = { givenname: "Ada", sn: "Lovelace" };

test("local full accounts may omit the email; the service applies the installation policy", async () => {
  create.mockResolvedValue({ ok: true, data: { id: targetId, uid: "ada", accountExpires: null, notificationSent: false } });
  const res = await post({ provider: "local", profile: "user", ...person });
  expect(res.status).toBe(201);
  expect(create.mock.calls[0]![0].data).toMatchObject({ provider: "local", profile: "user" });
  expect(create.mock.calls[0]![0].data.email).toBeUndefined();
});

test("FreeIPA, guest and request-backed creations still require an email", async () => {
  for (const body of [
    { provider: "ipa", ...person },
    { provider: "local", profile: "guest", ...person },
    { provider: "local", profile: "user", requestId: crypto.randomUUID(), ...person },
    { provider: "local", profile: "user", email: "", ...person },
  ]) {
    expect((await post(body)).status).toBe(400);
  }
  expect(create).not.toHaveBeenCalled();
});

test("admin updates pass an explicit null to remove an email", async () => {
  update.mockResolvedValue({ ok: true, data: undefined });
  const res = await users.request(`/${targetId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mail: null }),
  });
  expect(res.status).toBe(200);
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: targetId, data: { mail: null } }));
});

test("the user list reads the list's address: filters, search and sort reach the one directory query", async () => {
  const directory = spyOn(accountsAppService.user, "directory").mockResolvedValue({
    ok: true,
    data: { items: [], page: 1, perPage: 50, total: 0, hasNext: false },
  });
  try {
    const group = "33333333-3333-4333-8333-333333333333";
    const res = await users.request(
      `/?role=admin,guest&member-of=${group}&status=invited&passkey=no&q=ada&sort=login.asc&group=member-of&per_page=50`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ users: [], pagination: expect.objectContaining({ total: 0, per_page: 50 }) });
    expect(directory).toHaveBeenLastCalledWith({
      // the service checks the caller itself
      actor: expect.objectContaining({ userId: adminId, roles: ["admin"] }),
      search: "ada",
      roles: ["admin", "guest"],
      groupIds: [group],
      statuses: ["invited"],
      lastLogin: undefined,
      passkey: false,
      provider: undefined,
      duplicateMail: undefined,
      sort: { field: "lastLogin", direction: "asc" },
      pagination: { page: 1, perPage: 50 },
    });
    // the names before v2 still work: search is q, profile=guest is the guest role
    expect((await users.request("/?search=eva&profile=guest&provider=ipa")).status).toBe(200);
    expect(directory).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: "eva", roles: ["guest"], provider: "ipa", sort: { field: "name", direction: "asc" } }),
    );
    // a value the list cannot hold is refused, not dropped
    const refused = await users.request("/?role=owner");
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ message: expect.stringContaining("role") });
    // the API keeps its own pagination: a page past the list page's last one is still a page
    expect((await users.request("/?page=1001&per_page=20")).status).toBe(200);
    expect(directory).toHaveBeenLastCalledWith(expect.objectContaining({ pagination: { page: 1001, perPage: 20 } }));
    // a day the list cannot turn into an instant is refused up front, never a server error
    expect((await users.request("/?login=..9999-12-31")).status).toBe(400);
    expect((await users.request("/?login=0001-01-01..")).status).toBe(400);
    // the list of people takes the shared-address filter; other kinds belong to GET /api/accounts/accounts
    expect((await users.request("/?duplicate=yes&sort=mail.asc")).status).toBe(200);
    expect(directory).toHaveBeenLastCalledWith(expect.objectContaining({ duplicateMail: true, sort: { field: "mail", direction: "asc" } }));
    expect(directory.mock.lastCall?.[0]).not.toHaveProperty("kinds");
    const agents = await users.request("/?kind=agent");
    expect(agents.status).toBe(400);
    expect(await agents.json()).toMatchObject({ message: expect.stringContaining("kind") });
    expect((await users.request("/?kind=person")).status).toBe(200);
    expect(directory).toHaveBeenCalledTimes(5);
  } finally {
    directory.mockRestore();
  }
});

test("a refused directory answers with the service's status", async () => {
  const directory = spyOn(accountsAppService.user, "directory").mockResolvedValue({
    ok: false,
    error: { code: "FORBIDDEN", message: "Admin access required", status: 403 },
  });
  try {
    const res = await users.request("/");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ message: "Admin access required" });
  } finally {
    directory.mockRestore();
  }
});
