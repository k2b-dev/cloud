import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as navigation from "@k2b/ssr/nav";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

if (!isServer) {
  mock.module("@/api/client", () => ({ apiClient: { groups: { ":id": {} } } }));
  mock.module("../src/frontend/action-notice", () => ({ showAccountActionNotice: mock(async () => {}) }));
}
const flush = async () => {
  for (let n = 0; n < 20; n++) await Promise.resolve();
};

const copy = {
  en: {
    toggle: "Personal groups",
    tag: "Personal · of Quinn Doe",
    blocked: "This is Quinn Doe's personal Linux group. It can't be deleted while it is their primary group.",
  },
  de: {
    toggle: "Persönliche Gruppen",
    tag: "Persönlich · von Quinn Doe",
    blocked: "Das ist die persönliche Linux-Gruppe von Quinn Doe. Sie kann nicht gelöscht werden, solange sie deren primäre Gruppe ist.",
  },
} as const;
const owner = { id: "11111111-1111-4111-8111-111111111111", uid: "qdt", displayName: "Quinn Doe" };
const listState = { search: "", page: 1, provider: "" as const, scope: "all" as const, personal: false };

describe("personal Linux groups in Accounts", () => {
  if (isServer) {
    test.skip("requires the package DOM runner", () => {});
    return;
  }
  let cleanup = () => {};
  let dom: ReturnType<typeof createDomTestHarness>;
  const navigated = mock((_href: string) => {});
  beforeEach(() => {
    dom = createDomTestHarness();
    spyOn(navigation, "navigateTo").mockImplementation(navigated);
    cleanup = () => dom.cleanup();
  });
  afterEach(() => {
    cleanup();
    mock.restore();
    navigated.mockClear();
  });
  const mount = (factory: () => ReturnType<typeof createComponent>) => {
    const dispose = render(factory, dom.root);
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
  };
  const openMenu = async () => {
    dom.document.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click();
    await flush();
    return [...dom.document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]')];
  };

  for (const locale of ["en", "de"] as const) {
    test(`${locale}: the View menu toggles personal groups through the URL`, async () => {
      dom.document.documentElement.lang = locale;
      const { default: GroupsScopeFilter } = await import("../src/frontend/groups/GroupsScopeFilter.island");
      mount(() => createComponent(GroupsScopeFilter, { state: listState, defaultScope: "member" }));
      const toggle = (await openMenu()).find((item) => item.textContent?.includes(copy[locale].toggle));
      expect(toggle).toBeDefined();
      expect(toggle!.getAttribute("aria-checked")).toBe("false");
      toggle!.click();
      await flush();
      expect(navigated).toHaveBeenCalledWith("/app/accounts/groups?scope=all&personal=1");
    });

    test(`${locale}: an enabled toggle is checked and turning it off drops the URL flag`, async () => {
      dom.document.documentElement.lang = locale;
      const { default: GroupsScopeFilter } = await import("../src/frontend/groups/GroupsScopeFilter.island");
      mount(() => createComponent(GroupsScopeFilter, { state: { ...listState, personal: true }, defaultScope: "member" }));
      const toggle = (await openMenu()).find((item) => item.textContent?.includes(copy[locale].toggle));
      expect(toggle!.getAttribute("aria-checked")).toBe("true");
      toggle!.click();
      await flush();
      expect(navigated).toHaveBeenCalledWith("/app/accounts/groups?scope=all");
    });

    test(`${locale}: a personal group's delete action is disabled with an explanation`, async () => {
      dom.document.documentElement.lang = locale;
      const { prompts } = await import("@k2b/ui");
      const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
      const { default: GroupActions } = await import("../src/frontend/groups/detail/GroupActions.island");
      mount(() =>
        createComponent(GroupActions, {
          id: "group-id",
          name: "qdt",
          provider: "local",
          linuxEnabled: true,
          isPosix: true,
          description: null,
          personalOwnerName: owner.displayName,
          listHref: "/app/accounts/groups",
        }),
      );
      const remove = (await openMenu()).find((item) => item.textContent?.includes(copy[locale].blocked));
      expect(remove).toBeDefined();
      expect(remove!.getAttribute("aria-disabled")).toBe("true");
      remove!.click();
      await flush();
      expect(confirm).not.toHaveBeenCalled();
    });

    test(`${locale}: the personal tag names the owner and links admins to the user`, async () => {
      const { accountsMessages } = await import("../src/frontend/messages");
      const { default: PersonalGroupTag } = await import("../src/frontend/groups/PersonalGroupTag");
      const label = accountsMessages.resolve([locale]).t.personalGroupOf({ name: owner.displayName });
      expect(label).toBe(copy[locale].tag);
      mount(() => createComponent(PersonalGroupTag, { owner, label, linkToOwner: true }));
      const link = dom.root.querySelector("a");
      expect(link?.getAttribute("href")).toBe(`/app/accounts/users/${owner.id}`);
      expect(link?.textContent).toContain(copy[locale].tag);
    });
  }

  test("the personal tag is plain text for viewers who cannot open user details", async () => {
    const { default: PersonalGroupTag } = await import("../src/frontend/groups/PersonalGroupTag");
    mount(() => createComponent(PersonalGroupTag, { owner, label: copy.en.tag, linkToOwner: false }));
    expect(dom.root.querySelector("a")).toBeNull();
    expect(dom.root.textContent).toContain(copy.en.tag);
  });
});
