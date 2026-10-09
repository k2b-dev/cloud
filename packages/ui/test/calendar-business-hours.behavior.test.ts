import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

describe("@k2b/ui Calendar business-hours scroll", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("glides to the business hours, and jumps there with reduced motion", async () => {
    const behaviors: Array<string | undefined> = [];
    for (const reduced of [false, true]) {
      const dom = createDomTestHarness();
      const { default: Calendar } = await import("../src/content/Calendar");
      Object.defineProperty(dom.window, "matchMedia", {
        configurable: true,
        value: (query: string) => ({ matches: reduced && query === "(prefers-reduced-motion: reduce)" }),
      });
      Object.defineProperty(dom.window.HTMLElement.prototype, "scrollTo", {
        configurable: true,
        value: (options: { behavior?: string }) => behaviors.push(options.behavior),
      });
      const dispose = render(
        () => createComponent(Calendar, { date: "2026-08-12T12:00:00Z", view: "week", timeZone: "UTC", events: [] }),
        dom.root,
      );
      // The calendar scrolls in the first frame after it mounts.
      await new Promise((resolve) => dom.window.requestAnimationFrame(resolve));
      dispose();
      dom.cleanup();
    }
    expect(behaviors).toEqual(["smooth", "auto"]);
  });
});
