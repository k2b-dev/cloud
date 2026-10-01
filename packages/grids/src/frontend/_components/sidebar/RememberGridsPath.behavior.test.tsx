import { describe, expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

describe("the base page the Grids entry opens next", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  const setup = async () => {
    const dom = createDomTestHarness();
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => visibility });
    const { default: RememberGridsPath } = await import("./RememberGridsPath.island");
    const { parseLastGridsPath, setLastGridsPath } = await import("./GridsSettingsStore");
    const pages: Array<() => void> = [];
    return {
      open: (path: string) => pages.push(render(() => <RememberGridsPath path={path} />, dom.root)),
      setVisibility: (next: DocumentVisibilityState, event: "visibilitychange" | "pageshow" = "visibilitychange") => {
        visibility = next;
        if (event === "pageshow") dom.window.dispatchEvent(new dom.window.Event("pageshow"));
        else dom.document.dispatchEvent(new dom.window.Event("visibilitychange") as unknown as Event);
      },
      otherTabOpens: (path: string) => setLastGridsPath(path),
      last: () => parseLastGridsPath(dom.document.cookie),
      cleanup: () => {
        for (const dispose of pages) dispose();
        dom.cleanup();
      },
    };
  };

  test("ignores a base opened in a background tab until it is looked at", async () => {
    const page = await setup();
    try {
      page.otherTabOpens("/app/grids/BASE0A");
      page.setVisibility("hidden");
      page.open("/app/grids/BASE0B");
      expect(page.last()).toBe("/app/grids/BASE0A");
      page.setVisibility("visible");
      expect(page.last()).toBe("/app/grids/BASE0B");
    } finally {
      page.cleanup();
    }
  });

  test.each(["visibilitychange", "pageshow"] as const)("takes over again when its page is shown again (%s)", async (event) => {
    const page = await setup();
    try {
      page.open("/app/grids/BASE0A");
      expect(page.last()).toBe("/app/grids/BASE0A");
      page.setVisibility("hidden");
      page.otherTabOpens("/app/grids/BASE0B");
      page.setVisibility("visible", event);
      expect(page.last()).toBe("/app/grids/BASE0A");
    } finally {
      page.cleanup();
    }
  });
});
