import { afterEach, expect, spyOn, test } from "bun:test";
import * as provider from "../capabilities/server";
import type { LocalUser } from "../contracts/shared";
import type { RequestAuthority } from "../server";
import { managesPrincipalSearchTarget } from "./principal-search-target";

const user: LocalUser = {
  id: "viewer",
  uid: "viewer",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Viewer",
  sn: "",
  displayName: "Viewer",
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
const authority: RequestAuthority = {
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  credentialKind: "session",
  scopes: [],
};
const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
const manifest = { appId: "target", types: [{ localId: "item", reader: "item.read" }], queries: [{ localId: "item.read" }] };
for (const permission of ["none", "read", "write", "admin"] as const)
  test(`only the target's local Manage decision admits a handle (${permission})`, async () => {
    spies.push(spyOn(provider, "getCapabilityCatalogApp").mockResolvedValue({ ok: true, data: { manifest } } as never));
    const invoke = spyOn(provider, "invokeCapabilityWithDataSchema").mockResolvedValue({
      ok: true,
      data: { data: { view: { title: "A target", permission } } },
    } as never);
    spies.push(invoke);
    expect(await managesPrincipalSearchTarget({ type: "target.item", id: "item-1" }, authority, "de")).toBe(permission === "admin");
    expect(invoke.mock.calls[0]?.[0]).toEqual({ appId: "target", capabilityId: "item.read", kind: "query", input: { id: "item-1" } });
    expect(invoke.mock.calls[0]?.[2]).toMatchObject({ authority, locale: "de" });
  });

test("an unavailable target fails closed without breaking principal search", async () => {
  spies.push(spyOn(provider, "getCapabilityCatalogApp").mockRejectedValue(new Error("Offline")));
  expect(await managesPrincipalSearchTarget({ type: "target.item", id: "item-1" }, authority)).toBe(false);
});
