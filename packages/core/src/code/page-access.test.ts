import { afterEach, expect, spyOn, test } from "bun:test";
import { UserSchema } from "@k2b/cloud/contracts";
import type { CodeContext } from "./access";
import * as access from "./access";
import { type Code, CodeSchema } from "./contracts";
import { canReadCodePage } from "./page-access";
import * as store from "./store";

const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const user = UserSchema.parse({
  id,
  uid: "reader",
  roles: ["admin"],
  provider: "local",
  profile: "user",
  givenname: "Test",
  sn: "Reader",
  displayName: "Test Reader",
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
const context: CodeContext = {
  authority: { actor: { kind: "user", user }, accessSubject: { type: "user", userId: id }, credentialKind: "session", scopes: [] },
  locale: "en",
  signal: new AbortController().signal,
};
const code = (owner: Code["owner"]): Code =>
  CodeSchema.parse({
    id: "c_pageaccess",
    owner,
    title: "Page",
    serviceAccountId: null,
    serviceAccountHandle: null,
    state: "active",
    activeVersionId: null,
    pauseReason: null,
    pauseRows: [],
    pausePolicyRevision: null,
    createdBy: id,
    createdAt: "2026-11-08T00:00:00Z",
  });
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

test("resource pages require the normal owner reader under the visitor's authority, even with Code shares or admin role", async () => {
  const owned = code({ kind: "resource", ref: { type: "mail.mailbox", id: "mailbox" } });
  spies.push(spyOn(store, "findCode").mockResolvedValue(owned));
  const reader = spyOn(access, "readCodeOwner").mockResolvedValue(null);
  const shares = spyOn(access, "codeSharePermission").mockResolvedValue("read");
  spies.push(reader, shares);
  expect(await canReadCodePage(owned.id, context)).toBe(false);
  expect(reader).toHaveBeenCalledWith(owned.owner, context);
  expect(shares).not.toHaveBeenCalled();
  reader.mockResolvedValue({ title: "Mailbox", admin: false });
  expect(await canReadCodePage(owned.id, context)).toBe(true);
  reader.mockRejectedValue(new access.CodeOwnerUnavailableError("Unavailable"));
  await expect(canReadCodePage(owned.id, context)).rejects.toBeInstanceOf(access.CodeOwnerUnavailableError);
});

test("personal pages admit their owner and direct or group Code shares, without implicit administrator entry", async () => {
  const lookup = spyOn(store, "findCode").mockResolvedValue(code({ kind: "person", userId: id }));
  const shares = spyOn(access, "codeSharePermission").mockResolvedValue("none");
  spies.push(lookup, shares);
  expect(await canReadCodePage("c_pageaccess", context)).toBe(true);
  expect(shares).not.toHaveBeenCalled();
  lookup.mockResolvedValue(code({ kind: "person", userId: other }));
  expect(await canReadCodePage("c_pageaccess", context)).toBe(false);
  for (const permission of ["read", "write", "admin"] as const) {
    shares.mockResolvedValue(permission);
    expect(await canReadCodePage("c_pageaccess", context)).toBe(true);
    expect(shares).toHaveBeenLastCalledWith("c_pageaccess", context);
  }
  lookup.mockResolvedValue(null);
  expect(await canReadCodePage("c_pageaccess", context)).toBe(false);
});

test("app-owned pages use Code read permission", async () => {
  const owned = code({ kind: "app", appId: "example" });
  spies.push(spyOn(store, "findCode").mockResolvedValue(owned));
  const permission = spyOn(access, "codePermission").mockResolvedValue(null);
  spies.push(permission);
  expect(await canReadCodePage(owned.id, context)).toBe(false);
  permission.mockResolvedValue("reader");
  expect(await canReadCodePage(owned.id, context)).toBe(true);
});
