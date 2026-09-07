import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

describe("Spaces overview navigation", () => {
  if (isServer) {
    test.skip("runs with browser conditions", () => {});
    return;
  }

  test("enhances work links, restores history, and leaves modifier clicks native", async () => {
    const dom = createDomTestHarness();
    const previousCss = Object.getOwnPropertyDescriptor(globalThis, "CSS");
    Object.defineProperty(globalThis, "CSS", { configurable: true, value: dom.window.CSS });
    dom.window.history.replaceState(null, "", "/app/spaces");
    const { default: SpacesOverview } = await import("../src/frontend/SpacesOverview.island");
    const dispose = render(
      () =>
        createComponent(SpacesOverview, {
          spaces: [],
          initialView: "mine",
          initialPinnedSpaceIds: [],
          mine: [],
          today: [],
          upcoming: [],
          counts: { mine: 0, today: 0, upcoming: 0 },
          initialActivity: { items: [], nextCursor: null },
          initialActivityError: null,
          dateConfig: { locale: "en", timeZone: "Europe/Berlin", firstDayOfWeek: 1 },
        }),
      dom.root,
    );
    try {
      const today = dom.root.querySelector<HTMLAnchorElement>('a[href="/app/spaces?view=today"]')!;
      const upcoming = dom.root.querySelector<HTMLAnchorElement>('a[href="/app/spaces?view=upcoming"]')!;
      expect(today).not.toBeNull();
      expect(upcoming).not.toBeNull();
      const modified = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
      upcoming.dispatchEvent(modified);
      expect(modified.defaultPrevented).toBe(false);
      expect(upcoming.hasAttribute("aria-current")).toBe(false);
      // Happy DOM follows native anchors in the same window, including modifier clicks.
      dom.window.history.replaceState(null, "", "/app/spaces");
      today.focus();
      const click = new MouseEvent("click", { bubbles: true, cancelable: true });
      today.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
      expect(window.location.search).toBe("?view=today");
      expect(today.getAttribute("aria-current")).toBe("page");
      expect(document.activeElement).toBe(today);
      const length = window.history.length;
      today.click();
      expect(window.history.length).toBe(length);
      dom.window.history.replaceState(null, "", "/app/spaces?view=upcoming");
      dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
      expect(upcoming.getAttribute("aria-current")).toBe("page");
      expect(today.hasAttribute("aria-current")).toBe(false);
    } finally {
      dispose();
      dom.cleanup();
      if (previousCss) Object.defineProperty(globalThis, "CSS", previousCss);
      else Reflect.deleteProperty(globalThis, "CSS");
    }
  });
});
