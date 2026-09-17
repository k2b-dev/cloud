import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import { accountsAppService } from "@k2b/cloud/services";
import { session } from "@k2b/cloud/services/session";
import groups from "./groups";

const id = "11111111-1111-4111-8111-111111111111";
const group = { id, provider: "local" as const, name: "research-team", description: null, gidnumber: 200000 };
const user: User = {
  id,
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
const authenticate = spyOn(session, "authenticateRequest");
const create = spyOn(accountsAppService.group, "create");
const get = spyOn(accountsAppService.group, "get");
const prepare = spyOn(accountsAppService.group, "makePosix");
afterEach(() => {
  authenticate.mockReset();
  create.mockReset();
  get.mockReset();
  prepare.mockReset();
});
afterAll(() => {
  token.mockRestore();
  authenticate.mockRestore();
  create.mockRestore();
  get.mockRestore();
  prepare.mockRestore();
});
const login = (roles: User["roles"]) =>
  authenticate.mockResolvedValue({
    user: { ...user, roles },
    data: { userId: id, sid: "test-session", authEpoch: 0, expiresAt: "2099-01-01T00:00:00Z" },
  });
const post = () =>
  groups.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "local", name: "Research Team", posix: true }),
  });

test("POSIX creation and conversion require an authenticated administrator", async () => {
  authenticate.mockResolvedValue(null);
  expect((await post()).status).toBe(401);
  expect((await groups.request(`/${id}/posix`, { method: "PUT" })).status).toBe(401);
  login(["user", "group-manager"]);
  expect((await post()).status).toBe(403);
  expect((await groups.request(`/${id}/posix`, { method: "PUT" })).status).toBe(403);
  expect(create).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
});

test("local POSIX creation forwards the normalized name, actor and option once", async () => {
  login(["admin"]);
  create.mockResolvedValue({ ok: true, data: group });
  const response = await post();
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual(group);
  expect(create).toHaveBeenCalledTimes(1);
  expect(create.mock.calls[0]![0]).toMatchObject({ provider: "local", name: "research-team", posix: true, actor: { userId: id } });
});

test("the same conversion route forwards the canonical provider and preserves POSIX errors", async () => {
  login(["admin"]);
  for (const provider of ["local", "ipa"] as const) {
    get.mockResolvedValue({ ...group, provider, gidnumber: null });
    prepare.mockResolvedValue({ ok: true, data: { gidnumber: 200000 } });
    const converted = await groups.request(`/${id}/posix`, { method: "PUT" });
    expect(converted.status).toBe(200);
    expect(await converted.json()).toMatchObject({ gidNumber: 200000 });
    expect(prepare.mock.calls.at(-1)![0]).toMatchObject({ id, provider, actor: { userId: id } });
  }
  prepare.mockResolvedValue({ ok: false, error: { code: "setup_disabled", message: "setup_disabled", status: 409 } });
  const response = await groups.request(`/${id}/posix`, { method: "PUT" });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "setup_disabled" });
});
