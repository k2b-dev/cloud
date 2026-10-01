import { describe, expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

describe("the space the Spaces entry opens next", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  const setup = async () => {
    const dom = createDomTestHarness();
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => visibility });
    const { default: RememberSpace } = await import("../src/frontend/[id]/_components/workspace/RememberSpace.island");
    const { parseLastSpaceId, setLastSpaceId } = await import("../src/frontend/[id]/_components/settings/SpaceSettingsStore");
    const pages: Array<() => void> = [];
    return {
      open: (spaceId: string) => pages.push(render(() => <RememberSpace spaceId={spaceId} />, dom.root)),
      setVisibility: (next: DocumentVisibilityState, event: "visibilitychange" | "pageshow" = "visibilitychange") => {
        visibility = next;
        if (event === "pageshow") dom.window.dispatchEvent(new dom.window.Event("pageshow"));
        else dom.document.dispatchEvent(new dom.window.Event("visibilitychange") as unknown as Event);
      },
      otherTabOpens: (spaceId: string) => setLastSpaceId(spaceId),
      last: () => parseLastSpaceId(dom.document.cookie),
      cleanup: () => {
        for (const dispose of pages) dispose();
        dom.cleanup();
      },
    };
  };

  test("ignores a space opened in a background tab until it is looked at", async () => {
    const page = await setup();
    try {
      page.otherTabOpens("spaceA");
      page.setVisibility("hidden");
      page.open("spaceB");
      expect(page.last()).toBe("spaceA");
      page.setVisibility("visible");
      expect(page.last()).toBe("spaceB");
    } finally {
      page.cleanup();
    }
  });

  test.each(["visibilitychange", "pageshow"] as const)("takes over again when its page is shown again (%s)", async (event) => {
    const page = await setup();
    try {
      page.open("spaceA");
      expect(page.last()).toBe("spaceA");
      page.setVisibility("hidden");
      page.otherTabOpens("spaceB");
      page.setVisibility("visible", event);
      expect(page.last()).toBe("spaceA");
    } finally {
      page.cleanup();
    }
  });
});
