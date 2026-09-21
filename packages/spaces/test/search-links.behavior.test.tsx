import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import { reconcileSpacesDetailRoute } from "../src/frontend/[id]/_components/workspace/workspace-events";

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
});
