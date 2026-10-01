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
      open: (path: string) => {
        dom.window.history.replaceState(null, "", path);
        pages.push(render(() => <RememberGridsPath />, dom.root));
      },
      changeInPlace: (path: string) => dom.window.history.pushState(null, "", path),
      setVisibility: (next: DocumentVisibilityState, event: "visibilitychange" | "pageshow" | "focus" = "visibilitychange") => {
        visibility = next;
        if (event !== "visibilitychange") dom.window.dispatchEvent(new dom.window.Event(event));
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

  test.each(["visibilitychange", "pageshow", "focus"] as const)(
    "takes over again when its page is shown or focused again (%s)",
    async (event) => {
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
    },
  );

  test("records the address shown now, not the one the page was loaded with", async () => {
    const page = await setup();
    try {
      page.open("/app/grids/BASE0A/table/TABL01?record=REC001&edit=true");
      expect(page.last()).toBe("/app/grids/BASE0A/table/TABL01?record=REC001");
      // The record closes and the trash opens without a page load.
      page.changeInPlace("/app/grids/BASE0A/table/TABL01?trash=1&form=FORM01");
      page.setVisibility("hidden");
      page.otherTabOpens("/app/grids/BASE0B");
      page.setVisibility("visible");
      expect(page.last()).toBe("/app/grids/BASE0A/table/TABL01?trash=1");
    } finally {
      page.cleanup();
    }
  });
});
