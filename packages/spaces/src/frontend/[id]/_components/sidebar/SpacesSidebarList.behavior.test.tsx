import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";

if (isServer) {
  test.skip("sidebar hints use browser conditions", () => {});
} else {
  const dom = createDomTestHarness();
  afterAll(() => dom.cleanup());
  const { default: SpacesSidebarList } = await import("./SpacesSidebarList");
  const { default: SpaceNavigation } = await import("./SpaceNavigation.island");
  const { createPinnedSpaces, createSpacesNavigationItems, listenSpacesNavigationHints } = await import("./spaces-navigation");
  const { LocaleProvider } = await import("@k2b/ui");
  let dispose: (() => void) | undefined;
  afterEach(() => {
    dispose?.();
    dispose = undefined;
    dom.root.replaceChildren();
    dom.document.cookie = "cloud_seen_hints=; Path=/; Max-Age=0";
    dom.document.cookie = "settings-app-spaces=; Path=/; Max-Age=0";
  });
  const spaces = [
    { id: "Space1", name: "Launch", color: "#3b82f6", description: null, openItemCount: 2 },
    { id: "Space2", name: "Ideas", color: "#6366f1", description: null, openItemCount: 1 },
  ];
  const mount = (id: "spaces.sidebar-switch" | "spaces.overview-sidebar", open = true, locale = "en") => {
    dispose = render(
      () =>
        createComponent(LocaleProvider, {
          locale,
          get children() {
            return createComponent(SpacesSidebarList, {
              spaces,
              pinnedSpaceIds: [],
              myWorkCount: 3,
              canCreate: true,
              current: id === "spaces.sidebar-switch" ? { kind: "space", id: "Space1" } : { kind: "overview" },
              hint: { id, open },
            });
          },
        }),
      dom.root,
    );
  };

  test("a pin set in the sidebar reorders the phone title menu of the page at once", () => {
    let menu: () => string[] = () => [];
    dispose = render(
      () =>
        createComponent(LocaleProvider, {
          locale: "en",
          get children() {
            // The phone menu lives in another island; it reads the same page pins.
            const [pinned] = createPinnedSpaces([]);
            menu = () =>
              createSpacesNavigationItems({
                spaces,
                pinnedSpaceIds: pinned(),
                current: { kind: "space", id: "Space1" },
                canCreate: false,
                myWorkLabel: "My work",
                newSpaceLabel: "New space",
              }).map((item) => `${item.label}${item.icon === "ti ti-flag" ? " (pinned)" : ""}`);
            return createComponent(SpacesSidebarList, {
              spaces,
              pinnedSpaceIds: [],
              myWorkCount: 3,
              canCreate: true,
              current: { kind: "space", id: "Space1" },
            });
          },
        }),
      dom.root,
    );
    expect(menu()).toEqual(["My work", "Launch", "Ideas"]);
    const pin = dom.root.querySelector<HTMLButtonElement>('button[aria-label="Pin Ideas"]');
    expect(pin).not.toBeNull();
    pin!.click();
    expect(menu()).toEqual(["My work", "Ideas (pinned)", "Launch"]);
  });

  describe("sidebar moved hints", () => {
    for (const id of ["spaces.sidebar-switch", "spaces.overview-sidebar"] as const) {
      test(`${id} renders only when open; dismissal persists and hides it`, () => {
        mount(id, false);
        expect(dom.root.querySelector(".k2b-moved-hint")).toBeNull();
        dispose?.();
        mount(id);
        expect(dom.root.querySelector(".k2b-moved-hint")).not.toBeNull();
        const dismiss = Array.from(dom.root.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Got it");
        expect(dismiss).toBeDefined();
        dismiss?.click();
        expect(dom.document.cookie).toContain(id);
        expect(dom.root.querySelector(".k2b-moved-hint")).toBeNull();
      });
    }
    test("German dismissal says Verstanden and using a Space row marks both sidebar paths seen", () => {
      mount("spaces.sidebar-switch", true, "de");
      expect(Array.from(dom.root.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Verstanden")).toBe(true);
      const link = dom.root.querySelector<HTMLAnchorElement>('a[href="/app/spaces/Space2"]');
      link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(dom.document.cookie).toContain("spaces.sidebar-switch");
      expect(dom.document.cookie).toContain("spaces.overview-sidebar");
      expect(dom.root.querySelector(".k2b-moved-hint")).toBeNull();
    });
  });

  test("a phone title-menu Space link outside the sidebar also marks the new path; cleanup removes the listener", () => {
    const stop = listenSpacesNavigationHints(dom.document, spaces);
    const anchor = dom.document.createElement("a");
    anchor.href = "/app/spaces/Space2";
    dom.root.append(anchor);
    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(dom.document.cookie).toContain("spaces.sidebar-switch");
    expect(dom.document.cookie).toContain("spaces.overview-sidebar");
    stop();
    dom.document.cookie = "cloud_seen_hints=; Path=/; Max-Age=0";
    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(dom.document.cookie).not.toContain("spaces.sidebar-switch");
  });

  test("the registered phone menu has the Space name, object destinations, current Space, and creation action", () => {
    dispose = render(
      () =>
        createComponent(LocaleProvider, {
          locale: "en",
          get children() {
            return createComponent(SpaceNavigation, {
              sidebar: { spaces, pinnedSpaceIds: ["Space2"], myWorkCount: 3 },
              ctx: {
                userId: "user",
                space: {
                  id: "Space1",
                  name: "Launch",
                  color: "#3b82f6",
                  description: null,
                  icalToken: null,
                  createdAt: "2026-10-01T00:00:00Z",
                  updatedAt: "2026-10-01T00:00:00Z",
                  columns: [],
                  virtualColumns: [],
                  tags: [],
                  templates: [],
                },
                columns: [],
                tags: [],
                currentView: "list",
                query: "",
                hasOverride: false,
                settings: { view: "list", hideSettings: false },
                canWrite: false,
              },
            });
          },
        }),
      dom.root,
    );
    const registered = window.__cloudWorkspaceNavigation;
    expect(registered?.label).toBe("Launch");
    const items = registered?.navigation.items();
    expect(items?.map(({ id }) => id)).toEqual(["my-work", "Space2", "Space1", "new-space"]);
    expect(items?.filter(({ active }) => active).map(({ id }) => id)).toEqual(["Space1"]);
    expect(items?.[0]?.label).toBe("My work");
    expect(items?.at(-1)?.action).toBe("new-space");
    expect(registered?.navigation.switcher).toBeUndefined();
  });

  test("pinning changes the order, persists it, and announces the change", () => {
    mount("spaces.sidebar-switch", false);
    const button = dom.root.querySelector<HTMLButtonElement>('button[aria-label="Pin Ideas"]');
    expect(button).not.toBeNull();
    button?.click();
    const rows = dom.root.querySelectorAll<HTMLAnchorElement>("[data-space-id] a[href]");
    expect(rows[0]?.getAttribute("href")).toBe("/app/spaces/Space2");
    expect(dom.root.querySelector('[aria-live="polite"]')?.textContent).toContain("Pinned Ideas");
    expect(decodeURIComponent(dom.document.cookie)).toContain('"pinnedSpaceIds":["Space2"]');
  });
}
