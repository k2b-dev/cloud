import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

// Thirty invented Spaces as the server lists them, by name: "Space 01" … "Space 30".
const spaces = Array.from({ length: 30 }, (_, index) => {
  const n = String(index + 1).padStart(2, "0");
  return { id: `Spc0${n}`, name: `Space ${n}`, color: "#3b82f6", openItemCount: index };
});

describe("Spaces sidebar", () => {
  if (isServer) {
    test.skip("runs with browser conditions", () => {});
    return;
  }

  test("shows twenty of thirty Spaces with pinned and recent first, counts the rest, and finds one beyond them", async () => {
    const dom = createDomTestHarness();
    const previousCss = Object.getOwnPropertyDescriptor(globalThis, "CSS");
    Object.defineProperty(globalThis, "CSS", { configurable: true, value: dom.window.CSS });
    dom.window.history.replaceState(null, "", "/app/spaces");
    const { default: SpacesOverview } = await import("../src/frontend/SpacesOverview.island");
    const dispose = render(
      () =>
        createComponent(SpacesOverview, {
          spaces,
          initialView: "mine",
          initialPinnedSpaceIds: ["Spc029"],
          recentSpaceIds: ["Spc030"],
          unlistedSpaceCount: 0,
          initialWork: { view: "mine", items: [], counts: { mine: 0, today: 0, upcoming: 0 } },
          initialActivity: { items: [], nextCursor: null },
          initialActivityError: null,
          dateConfig: { locale: "en", timeZone: "Europe/Berlin", firstDayOfWeek: 1 },
          now: "2026-08-20T12:00:00.000Z",
        }),
      dom.root,
    );
    try {
      const nav = dom.root.querySelector<HTMLElement>('[data-k2-part="Nav"]')!;
      const spaceLinks = () =>
        [...nav.querySelectorAll<HTMLAnchorElement>('a.k2-ni[href^="/app/spaces/Spc"]')].map((link) => link.getAttribute("href"));
      expect(spaceLinks()).toHaveLength(20);
      expect(spaceLinks().slice(0, 3)).toEqual(["/app/spaces/Spc029", "/app/spaces/Spc030", "/app/spaces/Spc001"]);
      expect(spaceLinks()).not.toContain("/app/spaces/Spc025");
      expect(nav.textContent).toContain("+10 more");
      // The open counts stay beside each Space.
      expect(nav.querySelector('a[href="/app/spaces/Spc029"]')?.textContent).toContain("28");

      const search = nav.querySelector<HTMLInputElement>('input[type="search"]')!;
      expect(search.getAttribute("aria-label") ?? search.labels?.[0]?.textContent).toContain("Find a Space");
      search.value = "space 25";
      search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      expect(spaceLinks()).toEqual(["/app/spaces/Spc025"]);
      expect(nav.textContent).not.toContain("more");

      search.value = "";
      search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      expect(spaceLinks()).toHaveLength(20);
    } finally {
      dispose();
      dom.cleanup();
      if (previousCss) Object.defineProperty(globalThis, "CSS", previousCss);
      else Reflect.deleteProperty(globalThis, "CSS");
    }
  });

  test("holds no search with fewer than eight Spaces", async () => {
    const dom = createDomTestHarness();
    const previousCss = Object.getOwnPropertyDescriptor(globalThis, "CSS");
    Object.defineProperty(globalThis, "CSS", { configurable: true, value: dom.window.CSS });
    dom.window.history.replaceState(null, "", "/app/spaces");
    const { default: SpacesOverview } = await import("../src/frontend/SpacesOverview.island");
    const dispose = render(
      () =>
        createComponent(SpacesOverview, {
          spaces: spaces.slice(0, 7),
          initialView: "mine",
          initialPinnedSpaceIds: [],
          recentSpaceIds: [],
          unlistedSpaceCount: 0,
          initialWork: { view: "mine", items: [], counts: { mine: 0, today: 0, upcoming: 0 } },
          initialActivity: { items: [], nextCursor: null },
          initialActivityError: null,
          dateConfig: { locale: "en", timeZone: "Europe/Berlin", firstDayOfWeek: 1 },
          now: "2026-08-20T12:00:00.000Z",
        }),
      dom.root,
    );
    try {
      const nav = dom.root.querySelector<HTMLElement>('[data-k2-part="Nav"]')!;
      expect(nav.querySelectorAll('a.k2-ni[href^="/app/spaces/Spc"]')).toHaveLength(7);
      expect(nav.querySelector('input[type="search"]')).toBeNull();
      expect(nav.textContent).not.toContain("more");
    } finally {
      dispose();
      dom.cleanup();
      if (previousCss) Object.defineProperty(globalThis, "CSS", previousCss);
      else Reflect.deleteProperty(globalThis, "CSS");
    }
  });
});
