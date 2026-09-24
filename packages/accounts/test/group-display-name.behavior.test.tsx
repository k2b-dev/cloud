import { afterEach, describe, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

if (!isServer) mock.module("@/api/client", () => ({ apiClient: { groups: { ":id": {} } } }));

describe("group display names in Accounts", () => {
  if (isServer) {
    test.skip("requires the package DOM runner", () => {});
    return;
  }
  let cleanup = () => {};
  afterEach(() => cleanup());

  for (const [locale, shown] of [
    ["de", "Presse-Team"],
    ["en", "presse-team"],
  ] as const) {
    test(`${locale}: a parent group renders its display name and links by ID`, async () => {
      const dom = createDomTestHarness();
      const { LocaleProvider } = await import("@k2b/ui");
      const { default: MemberOfTab } = await import("../src/frontend/groups/detail/MemberOfTab");
      const dispose = render(
        () =>
          createComponent(LocaleProvider, {
            locale,
            get children() {
              return createComponent(MemberOfTab, {
                groupId: "child",
                groupProvider: "local",
                items: [
                  {
                    kind: "group",
                    group: { id: "parent", provider: "local", name: "presse-team", description: null, gidnumber: null },
                    relation: { direct: true },
                  },
                ],
                pagination: { page: 1, per_page: 100, total: 1, total_pages: 1, has_next: false },
                allParentGroupIds: ["parent"],
                isAdmin: false,
                groupHref: (id: string) => `/app/accounts/groups/${id}`,
                pageBaseUrl: "/app/accounts/groups/child?page=",
              });
            },
          }),
        dom.root,
      );
      cleanup = () => {
        dispose();
        dom.cleanup();
      };
      const link = dom.root.querySelector<HTMLAnchorElement>('a[href="/app/accounts/groups/parent"]');
      expect(link?.textContent?.trim()).toBe(shown);
    });
  }
});
