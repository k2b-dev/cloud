import { afterAll, expect, spyOn, test } from "bun:test";
import type { AccountDirectoryEntry, User } from "@k2b/cloud/contracts";
import { accountsAppService } from "@k2b/cloud/services";
import { session } from "@k2b/cloud/services/session";
import accounts from "./accounts";

const adminId = "11111111-1111-4111-8111-111111111111";
const user = (roles: User["roles"]): User => ({
  id: adminId,
  uid: "admin",
  provider: "local",
  profile: "user",
  roles,
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
});
const token = spyOn(session, "getToken").mockReturnValue("test-session");
const authenticate = spyOn(session, "authenticateRequest").mockResolvedValue({
  user: user(["admin"]),
  data: { userId: adminId, sid: "test-session", authEpoch: 0, kind: "web", expiresAt: "2099-01-01T00:00:00Z" },
});
afterAll(() => {
  token.mockRestore();
  authenticate.mockRestore();
});

const agent: AccountDirectoryEntry = {
  kind: "agent",
  id: "0b2f5c7e-0000-4000-8000-000000000001",
  name: "Wochenbericht",
  resource: null,
  status: "active",
  avatarHash: null,
  lastUsed: null,
  createdAt: "2026-09-22T09:14:00.000Z",
};

test("the account list reads the list's address: kinds, statuses, a shared address and the sort reach the one directory query", async () => {
  const directory = spyOn(accountsAppService.account, "directory").mockResolvedValue({
    ok: true,
    data: { items: [agent], page: 1, perPage: 50, total: 1, hasNext: false },
  });
  try {
    const res = await accounts.request("/?kind=agent,api-key&status=active,disabled&q=woche&sort=login.desc&group=mail&per_page=50");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accounts: [agent], pagination: expect.objectContaining({ total: 1, per_page: 50 }) });
    expect(directory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        // the service checks the caller itself
        actor: expect.objectContaining({ userId: adminId, roles: ["admin"] }),
        kinds: ["agent", "api-key"],
        statuses: ["active", "disabled"],
        search: "woche",
        sort: { field: "lastLogin", direction: "desc" },
        pagination: { page: 1, perPage: 50 },
      }),
    );
    expect((await accounts.request("/?duplicate=yes&sort=mail.asc")).status).toBe(200);
    expect(directory).toHaveBeenLastCalledWith(expect.objectContaining({ duplicateMail: true, sort: { field: "mail", direction: "asc" } }));
    // the address names the list's kinds, never a stored service account kind: anything else is refused, not dropped
    for (const kind of ["user_delegated", "resource_bound", "code"]) {
      const refused = await accounts.request(`/?kind=${kind}`);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ message: expect.stringContaining("kind") });
    }
    expect(directory).toHaveBeenCalledTimes(2);
  } finally {
    directory.mockRestore();
  }
});

test("a refused directory answers with the service's status", async () => {
  const directory = spyOn(accountsAppService.account, "directory").mockResolvedValue({
    ok: false,
    error: { code: "FORBIDDEN", message: "Admin access required", status: 403 },
  });
  try {
    const res = await accounts.request("/");
    expect(res.status).toBe(403);
  } finally {
    directory.mockRestore();
  }
});

test("a signed-in person without the administrator role never reaches the list", async () => {
  const directory = spyOn(accountsAppService.account, "directory");
  authenticate.mockResolvedValueOnce({
    user: user(["user"]),
    data: { userId: adminId, sid: "test-session", authEpoch: 0, kind: "web", expiresAt: "2099-01-01T00:00:00Z" },
  });
  try {
    const res = await accounts.request("/");
    expect(res.status).toBe(403);
    expect(directory).not.toHaveBeenCalled();
  } finally {
    directory.mockRestore();
  }
});
