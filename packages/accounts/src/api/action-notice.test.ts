import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import type { User } from "@valentinkolb/cloud/contracts";
import { accountsAppService, coreSettings } from "@valentinkolb/cloud/services";
import { session } from "@valentinkolb/cloud/services/session";
import notices from "./action-notice";

const user: User = {
  id: "notice-admin",
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
const getToken = spyOn(session, "getToken").mockReturnValue("test-session");
const authenticate = spyOn(session, "authenticateRequest");
const setting = spyOn(coreSettings, "get");
afterEach(() => {
  authenticate.mockReset();
  setting.mockReset();
});
afterAll(() => {
  getToken.mockRestore();
  authenticate.mockRestore();
  setting.mockRestore();
});
const login = (roles: User["roles"]) =>
  authenticate.mockResolvedValue({
    user: { ...user, roles },
    data: { userId: user.id, sid: "test-session", authEpoch: 0, expiresAt: "2099-01-01T00:00:00Z" },
  });
const post = (body: unknown) =>
  notices.request("/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("notices require authentication", async () => {
  authenticate.mockResolvedValue(null);
  expect((await post({ action: "user.delete" })).status).toBe(401);
  expect(setting).not.toHaveBeenCalled();
});
test("administrators receive bounded Markdown using only explicit context", async () => {
  login(["admin"]);
  setting.mockResolvedValue("Review folders for {{ name }}.");
  const response = await post({ action: "group.delete", name: "finance" });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ markdown: "Review folders for finance.", failed: false });
  expect(setting).toHaveBeenCalledWith("user.action_notice");
  expect((await post({ action: "user.create", password: "unexpected" })).status).toBe(400);
});
test("group managers receive group notices, not user notices", async () => {
  login(["user", "group-manager"]);
  setting.mockResolvedValue("Review access.");
  expect(await (await post({ action: "group.member.remove" })).json()).toEqual({ markdown: "Review access.", failed: false });
  expect(await (await post({ action: "user.delete" })).json()).toEqual({ markdown: null, failed: false });
  expect(setting).toHaveBeenCalledTimes(1);
});
test("ordinary users receive no administrator follow-up", async () => {
  login(["user"]);
  expect(await (await post({ action: "user.update" })).json()).toEqual({ markdown: null, failed: false });
  expect(setting).not.toHaveBeenCalled();
});
test("oversized request bodies are rejected before rendering", async () => {
  login(["admin"]);
  expect((await post({ action: "user.update", name: "x".repeat(32 * 1024) })).status).toBe(413);
  expect(setting).not.toHaveBeenCalled();
});
test("empty output is silent; a broken notice remains separate from the completed action", async () => {
  login(["admin"]);
  setting.mockResolvedValue("");
  expect(await (await post({ action: "user.update" })).json()).toEqual({ markdown: null, failed: false });
  setting.mockResolvedValue("{{ unavailable }}");
  expect(await (await post({ action: "user.update" })).json()).toEqual({ markdown: null, failed: true });
});
test("existing group notices use canonical name and provider; deletion retains its snapshot", async () => {
  login(["user", "group-manager"]);
  setting.mockResolvedValue("{{ provider }}: {{ name }} / {{ relatedId }}");
  const get = spyOn(accountsAppService.group, "get").mockResolvedValue({
    id: "group-id",
    name: "finance",
    provider: "ipa",
    description: null,
    gidnumber: null,
  });
  try {
    expect(await (await post({ action: "group.member.add", id: "group-id", relatedId: "member-id" })).json()).toEqual({
      markdown: "ipa: finance / member-id",
      failed: false,
    });
    get.mockResolvedValue(null);
    expect(await (await post({ action: "group.delete", id: "group-id", name: "finance", provider: "ipa" })).json()).toEqual({
      markdown: "ipa: finance /",
      failed: false,
    });
  } finally {
    get.mockRestore();
  }
});
