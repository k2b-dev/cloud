import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import * as navigation from "@k2b/ssr/nav";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

const patches: Record<string, unknown>[] = [];
if (!isServer) {
  mock.module("@/api/client", () => ({
    apiClient: {
      users: {
        ":id": {
          $patch: async ({ json }: { json: Record<string, unknown> }) => {
            patches.push(json);
            return Response.json({ message: "Updated" });
          },
        },
      },
    },
  }));
  mock.module("../src/frontend/action-notice", () => ({ showAccountActionNotice: async () => {} }));
}

const user = (mail: string | null, overrides: Partial<User> = {}): User => ({
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
  ...overrides,
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
  let unmount = () => {};
  let dom: ReturnType<typeof createDomTestHarness>;
  let prompts: typeof import("@k2b/ui").prompts;
  beforeEach(async () => {
    dom = createDomTestHarness();
    ({ prompts } = await import("@k2b/ui"));
    spyOn(navigation, "refreshCurrentPath").mockImplementation(() => {});
  });
  afterEach(() => {
    unmount();
    unmount = () => {};
    dom.cleanup();
    mock.restore();
    patches.length = 0;
  });

  const menuFor = async (target: User, localEmailOptional = false) => {
    unmount();
    const { default: UserActions } = await import("../src/frontend/users/detail/UserActions.island");
    unmount = render(
      () => createComponent(UserActions, { user: target, listHref: "/app/accounts/users", freeIpaEnabled: true, localEmailOptional }),
      dom.root,
    );
    dom.document.querySelector<HTMLButtonElement>('button[aria-label="User actions"]')!.click();
    await flush();
    return dom.document.body.textContent ?? "";
  };
  const edit = async () => {
    const item = [...dom.document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((entry) => entry.textContent?.trim() === "Edit");
    if (!item) throw new Error("Missing Edit action");
    item.click();
    await flush();
  };
  type FormFields = Record<string, { required?: boolean; description?: string }>;
  const mailField = (form: ReturnType<typeof spyOn>) => (form.mock.calls[0]![0] as { fields: FormFields }).fields.mail!;
  const cleared = { givenname: "Ada", sn: "Lovelace", displayName: "Ada Lovelace", mail: " " };

  test("accounts without email keep the login token and hide email-only actions", async () => {
    const menu = await menuFor(user(null));
    expect(menu).toContain("Login token");
    expect(menu).not.toContain("Notify");
    expect(menu).not.toContain("Create FreeIPA account");
  });

  test("accounts with email offer every action", async () => {
    const menu = await menuFor(user("ada@example.com"));
    expect(menu).toContain("Login token");
    expect(menu).toContain("Notify");
    expect(menu).toContain("Create FreeIPA account");
  });

  test("the emergency admin account offers no login token", async () => {
    const menu = await menuFor(user(null, { uid: "admin", roles: ["user", "admin"] }));
    expect(menu).not.toContain("Login token");
  });

  test("an address that must stay is a required field, so the server never has to refuse its removal", async () => {
    const form = spyOn(prompts, "form").mockResolvedValue(null);
    await menuFor(user("ada@example.com"));
    await edit();
    expect(mailField(form)).toMatchObject({ required: true });
    expect(mailField(form).description).toBeUndefined();

    // A guest keeps a required address even while the installation allows accounts without one.
    form.mockClear();
    await menuFor(user("ada@example.com", { profile: "guest" }), true);
    await edit();
    expect(mailField(form)).toMatchObject({ required: true });
  });

  test("removing an address explains the consequence and needs a confirmation", async () => {
    const form = spyOn(prompts, "form").mockResolvedValue(cleared);
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(false);
    await menuFor(user("ada@example.com"), true);
    await edit();
    expect(mailField(form)).toMatchObject({ required: false, description: expect.stringContaining("Optional") });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![1]?.title).toContain("ada@example.com");
    expect(String(confirm.mock.calls[0]![0])).toContain("paired app");
    expect(patches).toHaveLength(0);

    confirm.mockResolvedValue(true);
    await edit();
    await flush();
    expect(patches).toEqual([{ givenname: "Ada", sn: "Lovelace", displayName: "Ada Lovelace", mail: null }]);
  });

  test("editing an account that already has no address neither asks nor changes it", async () => {
    spyOn(prompts, "form").mockResolvedValue({ ...cleared, displayName: "Ada" });
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
    await menuFor(user(null), true);
    await edit();
    await flush();
    expect(confirm).not.toHaveBeenCalled();
    expect(patches).toEqual([{ givenname: "Ada", sn: "Lovelace", displayName: "Ada" }]);
  });
});
