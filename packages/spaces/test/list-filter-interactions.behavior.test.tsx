import { expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

test.skipIf(isServer)("list filters retain rapid choices while displayed results remain committed", async () => {
  const dom = createDomTestHarness();
  const previousCss = Object.getOwnPropertyDescriptor(globalThis, "CSS");
  Object.defineProperty(globalThis, "CSS", { configurable: true, value: dom.window.CSS });
  const base = "/app/spaces/Space1?view=list&q=initial";
  dom.window.history.replaceState(null, "", base);
  const requests: string[] = [];
  mock.module("../src/frontend/[id]/_components/workspace/view-query", () => ({
    SpacesViewUnavailableError: class extends Error {},
    loadSpacesViewSnapshot: (href: string) => {
      requests.push(href);
      return new Promise(() => {});
    },
  }));
  const { default: SpacesListRoute } = await import("../src/frontend/[id]/_components/workspace/SpacesListRoute.island");
  const { parseFilterFromUrl } = await import("../src/frontend/[id]/_components/filter/types");
  const dispose = render(
    () =>
      createComponent(SpacesListRoute, {
        spaceId: "Space1",
        currentView: "list",
        columns: [],
        tags: [],
        filter: parseFilterFromUrl(new URL(base, "http://localhost")),
        initialItemsResult: { items: [], total: 7, page: 1, pageSize: 50, totalPages: 1 },
        initialSelectedItemId: "",
        itemLinkBaseUrl: base,
        paginationBaseUrl: "unused",
        canWrite: false,
      }),
    dom.root,
  );
  const click = async (label: string, selector = "button") => {
    const element = Array.from(dom.document.querySelectorAll<HTMLElement>(selector)).find((node) => node.textContent?.trim() === label);
    expect(element).toBeDefined();
    element!.click();
    await flush();
  };
  try {
    await flush();
    await click("Priority");
    await click("High", '[role="menuitemcheckbox"]');
    await click("Low", '[role="menuitemcheckbox"]');
    expect(new URL(requests.at(-1)!, "http://localhost").searchParams.get("priority")).toBe("high,low");
    expect(dom.document.querySelectorAll('[role="menuitemcheckbox"][aria-checked="true"]')).toHaveLength(2);
    dom.document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    await click("Scope");
    await click("Tasks", '[role="menuitemradio"]');
    await click("Done", '[role="menuitemradio"]');
    const requested = new URL(requests.at(-1)!, "http://localhost");
    expect(requested.searchParams.get("type")).toBe("task");
    expect(requested.searchParams.get("status")).toBe("completed");
    expect(dom.root.textContent).toContain("initial");
    expect(dom.window.location.search).toBe("?view=list&q=initial");

    const input = dom.root.querySelector("input")!;
    input.focus();
    input.value = "unsent draft";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    dom.root.querySelector<HTMLAnchorElement>('a[aria-label="Clear all filters"]')!.click();
    await flush();
    expect(input.value).toBe("");
    const clearRequest = requests.at(-1);
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(requests.at(-1)).toBe(clearRequest);
    expect(new URL(clearRequest!, "http://localhost").searchParams.has("q")).toBe(false);
    expect(dom.root.textContent).toContain("initial");
  } finally {
    dispose();
    dom.cleanup();
    if (previousCss) Object.defineProperty(globalThis, "CSS", previousCss);
    else Reflect.deleteProperty(globalThis, "CSS");
  }
});
