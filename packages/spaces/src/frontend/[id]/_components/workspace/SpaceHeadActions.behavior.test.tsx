import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { clipboard } from "@k2b/stdlib/browser";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../../../ui/test/dom";

if (isServer) {
  test.skip("Space head actions use browser conditions", () => {});
} else {
  const bootstrap = createDomTestHarness();
  afterAll(() => bootstrap.cleanup());
  const { default: SpaceHeadActions } = await import("./SpaceHeadActions.island");
  const { prompts, LocaleProvider } = await import("@k2b/ui");
  let dom: DomTestHarness;
  let dispose: (() => void) | undefined;
  beforeEach(() => {
    dom = bootstrap;
    dom.document.documentElement.style.fontSize = "16px";
    dom.document.documentElement.style.width = "1194px";
  });
  afterEach(() => {
    dispose?.();
    dispose = undefined;
    dom.root.replaceChildren();
    dom.document.cookie = "cloud_seen_hints=; Max-Age=0; Path=/";
  });
  const mount = (
    options: {
      view?: "kanban" | "list";
      token?: string | null;
      hintOpen?: boolean;
      locale?: string;
      serviceAccountKind?: "standalone" | "agent";
    } = {},
  ) => {
    dispose = render(
      () =>
        createComponent(LocaleProvider, {
          locale: options.locale ?? "en",
          get children() {
            return createComponent(SpaceHeadActions, {
              spaceId: "Space1",
              spaceName: "Planning",
              baseUrl: "/app/spaces/Space1",
              canWrite: true,
              currentView: options.view ?? "kanban",
              icalToken: options.token === undefined ? "calendar-token" : options.token,
              hintOpen: options.hintOpen,
              people: [
                { id: "11111111-1111-4111-8111-111111111111", uid: "mara", displayName: "Mara Lind", avatarHash: null, kind: "user" },
                {
                  id: "22222222-2222-4222-8222-222222222222",
                  uid: "worker",
                  displayName: "Task worker",
                  avatarHash: null,
                  kind: "service_account",
                  serviceAccountKind: options.serviceAccountKind ?? "standalone",
                },
              ],
            });
          },
        }),
      dom.root,
    );
  };
  const clickText = (text: string) => {
    const button = Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find(
      (entry) => entry.textContent?.trim() === text,
    );
    expect(button).toBeDefined();
    button?.click();
  };
  const openMenu = () => dom.root.querySelector<HTMLButtonElement>("[data-spaces-menu]")?.click();
  const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

  describe("Space head menu", () => {
    test.each(["standalone", "agent"] as const)(
      "%s: runs settings, iCal and Kanban shortcuts from the menu",
      async (serviceAccountKind) => {
        const dialog = spyOn(prompts, "dialog").mockResolvedValue(undefined);
        const copy = spyOn(clipboard, "copy").mockResolvedValue(undefined);
        try {
          mount({ serviceAccountKind });
          openMenu();
          expect(dom.document.querySelector('[role="menu"]')?.textContent).toContain("People with access");
          expect(dom.root.querySelector("[data-spaces-people-row]")?.getAttribute("aria-label")).toContain("Mara Lind, Task worker");
          expect(dom.root.querySelector(`[data-spaces-people-row] .ti-${serviceAccountKind === "agent" ? "robot" : "key"}`)).not.toBeNull();
          expect(dom.document.querySelector(`[role="menu"] .ti-${serviceAccountKind === "agent" ? "robot" : "key"}`)).not.toBeNull();
          clickText("Space settings");
          await settle();
          expect(dialog).toHaveBeenCalledTimes(1);
          openMenu();
          clickText("Copy iCal URL");
          await settle();
          expect(copy).toHaveBeenCalledWith("http://localhost/api/spaces/calendar/ical/calendar-token.ics");
          expect(dom.root.querySelector('[role="status"]')?.textContent).toBe("Copied iCal URL");
          openMenu();
          clickText("Keyboard shortcuts");
          expect(dialog).toHaveBeenCalledTimes(2);
          expect(dialog.mock.calls[1]?.[1]?.title).toBe("Keyboard shortcuts");
        } finally {
          dialog.mockRestore();
          copy.mockRestore();
        }
      },
    );

    test("lists people in the menu only below the app host threshold", () => {
      dom.document.documentElement.style.width = "1440px";
      mount();
      openMenu();
      expect(dom.document.querySelector('[role="menu"]')?.textContent).not.toContain("People with access");
      openMenu();
      dom.document.documentElement.style.width = "1194px";
      openMenu();
      expect(dom.document.querySelector('[role="menu"]')?.textContent).toContain("People with access");
    });

    test("omits iCal without a token and shortcuts outside Kanban", () => {
      mount({ view: "list", token: null });
      openMenu();
      const menu = dom.document.querySelector('[role="menu"]')?.textContent;
      expect(menu).toContain("Space settings");
      expect(menu).not.toContain("Copy iCal URL");
      expect(menu).not.toContain("Keyboard shortcuts");
    });

    test.each(["en", "de"])("dismisses the menu hint and persists seen state (%s)", (locale) => {
      mount({ hintOpen: true, locale });
      expect(dom.root.querySelector(".k2b-moved-hint")).not.toBeNull();
      clickText(locale === "de" ? "Verstanden" : "Got it");
      expect(dom.root.querySelector(".k2b-moved-hint")).toBeNull();
      expect(dom.document.cookie).toContain("spaces.space-menu");
    });

    test.each([
      { view: "kanban" as const, token: "calendar-token", text: "Space settings, the iCal URL, and keyboard shortcuts are now under “…”." },
      { view: "list" as const, token: "calendar-token", text: "Space settings and the iCal URL are now under “…”." },
      { view: "kanban" as const, token: null, text: "Space settings and keyboard shortcuts are now under “…”." },
      { view: "list" as const, token: null, text: "Space settings are now under “…”." },
    ])("the menu hint names only the items the menu has ($view, iCal $token)", ({ view, token, text }) => {
      mount({ hintOpen: true, view, token });
      expect(dom.root.querySelector(".k2b-moved-hint")?.textContent).toContain(text);
    });

    test("using the menu dismisses and persists its hint", () => {
      mount({ hintOpen: true });
      openMenu();
      expect(dom.root.querySelector(".k2b-moved-hint")).toBeNull();
      expect(dom.document.cookie).toContain("spaces.space-menu");
    });

    test("hint action opens the menu", () => {
      mount({ hintOpen: true });
      clickText("Open menu");
      expect(dom.document.querySelector('[role="menu"]')?.textContent).toContain("Space settings");
      expect(dom.document.cookie).toContain("spaces.space-menu");
    });
  });
}
