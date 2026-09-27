import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import { AppApprovalError, accountsAppService, appApproval, notifications } from "@k2b/cloud/services";
import { session } from "@k2b/cloud/services/session";
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
  data: { userId: adminId, sid: "test-session", authEpoch: 0, expiresAt: "2099-01-01T00:00:00Z" },
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
    data: { userId: adminId, sid: "test-session", authEpoch: 0, expiresAt: "2099-01-01T00:00:00Z" },
  });
  authenticate.mockResolvedValueOnce({
    user: { ...admin, roles: [] },
    data: { userId: adminId, sid: "test-session", authEpoch: 0, expiresAt: "2099-01-01T00:00:00Z" },
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
