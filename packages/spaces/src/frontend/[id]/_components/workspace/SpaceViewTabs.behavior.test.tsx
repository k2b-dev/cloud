import { afterAll, afterEach, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";

if (isServer) test.skip("view tab hints use browser conditions", () => {});
else {
  const dom = createDomTestHarness();
  afterAll(() => dom.cleanup());
  afterEach(() => {
    dom.root.replaceChildren();
    dom.document.cookie = "cloud_seen_hints=; Max-Age=0; Path=/";
  });
  for (const usePath of [false, true]) {
    test(`the view hint is seen by ${usePath ? "using a tab" : "Got it"}`, async () => {
      dom.window.history.replaceState(null, "", "/app/spaces/Space1?view=table");
      const { default: SpaceViewTabs } = await import("./SpaceViewTabs.island");
      const dispose = render(
        () =>
          createComponent(SpaceViewTabs, {
            spaceId: "Space1",
            query: "view=table",
            currentView: "table",
            hintOpen: true,
          }),
        dom.root,
      );
      try {
        expect(dom.root.textContent).toContain("List, Table, Kanban, and Calendar are now tabs at the top of the page.");
        expect(dom.root.querySelector('[aria-current="page"]')?.textContent).toContain("Table");
        if (usePath) {
          const event = new MouseEvent("click", { bubbles: true, cancelable: true });
          dom.root.querySelector<HTMLAnchorElement>('[aria-current="page"]')!.dispatchEvent(event);
        } else {
          Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button"))
            .find((button) => button.textContent === "Got it")!
            .click();
        }
        expect(decodeURIComponent(dom.document.cookie)).toContain("spaces.view-tabs");
        expect(dom.root.textContent).not.toContain("List, Table, Kanban, and Calendar are now tabs at the top of the page.");
      } finally {
        dispose();
      }
    });
  }
  test("Show focuses the current tab and dismisses the hint", async () => {
    const { default: SpaceViewTabs } = await import("./SpaceViewTabs.island");
    const dispose = render(
      () =>
        createComponent(SpaceViewTabs, {
          spaceId: "Space1",
          query: "view=kanban",
          currentView: "kanban",
          hintOpen: true,
        }),
      dom.root,
    );
    try {
      Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent === "Show")!
        .click();
      expect(dom.document.activeElement).toBe(dom.root.querySelector('[aria-current="page"]'));
      expect(decodeURIComponent(dom.document.cookie)).toContain("spaces.view-tabs");
    } finally {
      dispose();
    }
  });
  test("a view chosen under More also marks the moved path as seen", async () => {
    dom.window.history.replaceState(null, "", "/app/spaces/Space1?view=list");
    const { default: SpaceViewTabs } = await import("./SpaceViewTabs.island");
    const dispose = render(
      () =>
        createComponent(SpaceViewTabs, {
          spaceId: "Space1",
          query: "view=list",
          currentView: "list",
          hintOpen: true,
        }),
      dom.root,
    );
    try {
      // DOM harness has no CSS layout; model the tab hidden by the compact strip.
      Object.defineProperty(dom.root.querySelector('[data-view-tab="calendar"]'), "getClientRects", { value: () => [] });
      dom.root.querySelector<HTMLButtonElement>(".k2b-view-tabs__more-trigger")!.click();
      const calendar = dom.document.querySelector<HTMLAnchorElement>('[role="menuitem"][href*="view=calendar"]');
      expect(calendar).not.toBeNull();
      calendar!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(dom.document.cookie).toContain("spaces.view-tabs");
      expect(dom.root.querySelector(".k2b-moved-hint")).toBeNull();
    } finally {
      dispose();
    }
  });
}
