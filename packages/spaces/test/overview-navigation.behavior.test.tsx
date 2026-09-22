import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

describe("Spaces overview navigation", () => {
  if (isServer) {
    test.skip("runs with browser conditions", () => {});
    return;
  }

  test("keeps the selected work view in the URL and restores it from history", async () => {
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
          initialWork: { view: "mine", items: [], counts: { mine: 0, today: 0, upcoming: 0 } },
          initialActivity: { items: [], nextCursor: null },
          initialActivityError: null,
          dateConfig: { locale: "en", timeZone: "Europe/Berlin", firstDayOfWeek: 1 },
        }),
      dom.root,
    );
    try {
      const option = (label: string) =>
        Array.from(dom.root.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find((button) => button.textContent?.startsWith(label))!;
      const today = option("Today");
      const upcoming = option("Upcoming");
      expect(today).toBeDefined();
      expect(upcoming).toBeDefined();
      expect(option("For me").getAttribute("aria-checked")).toBe("true");
      today.focus();
      today.click();
      expect(window.location.search).toBe("?view=today");
      expect(today.getAttribute("aria-checked")).toBe("true");
      expect(document.activeElement).toBe(today);
      const length = window.history.length;
      today.click();
      expect(window.history.length).toBe(length);
      dom.window.history.replaceState(null, "", "/app/spaces?view=upcoming");
      dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
      expect(upcoming.getAttribute("aria-checked")).toBe("true");
      expect(today.getAttribute("aria-checked")).toBe("false");
    } finally {
      dispose();
      dom.cleanup();
      if (previousCss) Object.defineProperty(globalThis, "CSS", previousCss);
      else Reflect.deleteProperty(globalThis, "CSS");
    }
  });
});
