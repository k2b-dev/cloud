import { afterEach, describe, expect, mock, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

if (!isServer) mock.module("@/api/client", () => ({ apiClient: { users: { ":id": {} } } }));

const user = (mail: string | null): User => ({
  id: "local-id",
  uid: "ada",
  provider: "local",
  profile: "user",
  roles: ["user"],
  givenname: "Ada",
  sn: "Lovelace",
  displayName: "Ada Lovelace",
  mail,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
});
const flush = async () => {
  for (let n = 0; n < 20; n++) await Promise.resolve();
};

// Happy DOM exercises component behavior only; this is not a browser clickthrough.
describe("user actions", () => {
  if (isServer) {
    test.skip("requires the package DOM runner", () => {});
    return;
  }
  let cleanup = () => {};
  afterEach(() => cleanup());

  const menuFor = async (mail: string | null) => {
    const dom = createDomTestHarness();
    const { default: UserActions } = await import("../src/frontend/users/detail/UserActions.island");
    const dispose = render(
      () => createComponent(UserActions, { user: user(mail), listHref: "/app/accounts/users", freeIpaEnabled: true }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    dom.document.querySelector<HTMLButtonElement>('button[aria-label="User actions"]')!.click();
    await flush();
    return dom.document.body.textContent ?? "";
  };

  test("accounts without email keep the login token and hide email-only actions", async () => {
    const menu = await menuFor(null);
    expect(menu).toContain("Login token");
    expect(menu).not.toContain("Notify");
    expect(menu).not.toContain("Create FreeIPA account");
  });

  test("accounts with email offer every action", async () => {
    const menu = await menuFor("ada@example.com");
    expect(menu).toContain("Login token");
    expect(menu).toContain("Notify");
    expect(menu).toContain("Create FreeIPA account");
  });
});
