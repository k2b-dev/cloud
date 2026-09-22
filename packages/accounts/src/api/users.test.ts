import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import { accountsAppService } from "@k2b/cloud/services";
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
