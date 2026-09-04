import { describe, expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import {
  reconcileSpacesDetailRoute,
  SPACES_DETAIL_NAVIGATION_EVENT,
  type SpacesDetailNavigation,
} from "../src/frontend/[id]/_components/workspace/workspace-events";

describe("Spaces search navigation links", () => {
  if (isServer) {
    test.skip("runs with browser conditions", () => {});
    return;
  }
  test.each(["mobile", "desktop", "collapsed"] as const)(
    "%s view hrefs follow committed filters without intercepting modifier clicks",
    async (variant) => {
      const dom = createDomTestHarness();
      dom.window.history.replaceState(null, "", "/app/spaces/Space1?view=list&q=initial");
      const { default: ViewLinks } = await import("../src/frontend/[id]/_components/sidebar/ViewLinks");
      const dispose = render(
        () => createComponent(ViewLinks, { spaceId: "Space1", query: "view=list&q=initial", currentView: "list", variant }),
        dom.root,
      );
      try {
        const links = () => Array.from(dom.root.querySelectorAll<HTMLAnchorElement>("a"));
        expect(links()).toHaveLength(4);
        if (variant !== "collapsed") expect(links().every((link) => link.dataset.mode === variant)).toBe(true);
        expect(links().every((link) => new URL(link.href).searchParams.get("q") === "initial")).toBe(true);
        reconcileSpacesDetailRoute("/app/spaces/Space1?view=list&q=committed&status=all");
        expect(links().every((link) => new URL(link.href).searchParams.get("q") === "committed")).toBe(true);
        expect(links().every((link) => new URL(link.href).searchParams.get("status") === "all")).toBe(true);
        const click = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
        links()[1]!.dispatchEvent(click);
        expect(click.defaultPrevented).toBe(false);
        reconcileSpacesDetailRoute("/app/spaces/Other?view=list&q=unrelated");
        expect(links().every((link) => new URL(link.href).searchParams.get("q") === "committed")).toBe(true);
      } finally {
        dispose();
        dom.cleanup();
      }
    },
  );

  test("a late-mounted sidebar starts from the current URL", async () => {
    const dom = createDomTestHarness();
    dom.window.history.replaceState(null, "", "/app/spaces/Space1?view=list&q=already-committed");
    const { default: ViewLinks } = await import("../src/frontend/[id]/_components/sidebar/ViewLinks");
    const dispose = render(
      () => createComponent(ViewLinks, { spaceId: "Space1", query: "view=list&q=initial", currentView: "list", variant: "desktop" }),
      dom.root,
    );
    try {
      const links = Array.from(dom.root.querySelectorAll<HTMLAnchorElement>("a"));
      expect(links.every((link) => new URL(link.href).searchParams.get("q") === "already-committed")).toBe(true);
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("Spotlight selection preserves the current list search instead of its SSR query", async () => {
    const dom = createDomTestHarness();
    const ui = await import("@k2b/ui");
    const { default: SearchButton } = await import("../src/frontend/[id]/_components/search/SearchButton");
    dom.window.history.replaceState(null, "", "/app/spaces/Space1?view=list&q=current&status=all");
    const select = spyOn(ui, "openSpotlightSearch").mockResolvedValue({ value: { id: "Item1" }, label: "Task" });
    let navigation: SpacesDetailNavigation | undefined;
    const onNavigate = (event: Event) => {
      navigation = (event as CustomEvent<SpacesDetailNavigation>).detail;
    };
    window.addEventListener(SPACES_DETAIL_NAVIGATION_EVENT, onNavigate);
    const dispose = render(
      () =>
        createComponent(SearchButton, {
          spaceId: "Space1",
          spaceName: "Space",
          columns: [],
          query: "view=list&q=initial",
          variant: "icon",
        }),
      dom.root,
    );
    try {
      dom.root.querySelector<HTMLButtonElement>("button")!.click();
      await Promise.resolve();
      await Promise.resolve();
      expect(navigation).toBeDefined();
      const url = new URL(navigation!.href, window.location.origin);
      expect(url.searchParams.get("q")).toBe("current");
      expect(url.searchParams.get("status")).toBe("all");
      expect(url.searchParams.get("item")).toBe("Item1");
    } finally {
      dispose();
      select.mockRestore();
      window.removeEventListener(SPACES_DETAIL_NAVIGATION_EVENT, onNavigate);
      dom.cleanup();
    }
  });
});
