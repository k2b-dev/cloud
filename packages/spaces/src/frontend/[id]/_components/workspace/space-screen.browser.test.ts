import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { launchHookMs, settled } from "../../../../../../ui/test/browser";
import { createScreenBrowser, layoutProblems, narrow, phone, type View, wide } from "../../../../../test/v2-screen-browser";
import { SPACE_NOW, type SpaceFixtureState, spaceScreenProps } from "./space-screen.fixture";

// A Space on v2: its list, table and board, the filters in the address, the open item beside the list, ticking a task
// off and starting a new one. The test stands in for the server: the page renders invented data, the API answers from it.
const screen = createScreenBrowser(resolve(import.meta.dir, "space-screen.browser-harness.tsx"));
beforeAll(screen.start, launchHookMs);
afterAll(screen.stop);

type Seen = { views: string[]; completed: unknown[] };
const open = (view: View, address: string, state: SpaceFixtureState = "usual") => {
  const seen: Seen = { views: [], completed: [] };
  const page = screen.open(view, address, {
    pages: ["/app/spaces/Space1"],
    now: SPACE_NOW,
    state,
    api: (url, route) => {
      if (url.pathname === "/api/spaces/workspace/view") {
        const href = url.searchParams.get("href") ?? "";
        seen.views.push(href);
        const props = spaceScreenProps(href, state).state;
        const viewName = props.currentView;
        return viewName === "kanban"
          ? { kind: "kanban", buckets: props.kanbanBuckets, wormholes: [] }
          : { kind: "list", currentView: viewName === "table" ? "table" : "list", itemsResult: props.itemsResult };
      }
      const detail = url.pathname.match(/^\/api\/spaces\/Space1\/items\/([^/]+)\/detail$/);
      if (detail) {
        const found = spaceScreenProps(`/app/spaces/Space1?item=${detail[1]}`, state).state.selectedItemDetail;
        return found ?? Response.json({ message: "Not found" }, { status: 404 });
      }
      if (url.pathname.endsWith("/completed") && route.request().method() === "POST") {
        seen.completed.push(route.request().postDataJSON());
        const id = url.pathname.split("/").at(-2);
        const item = spaceScreenProps("/app/spaces/Space1", state).state.itemsResult.items.find((entry) => entry.id === id);
        return { ...item, completedAt: "2026-10-15T07:00:00.000Z" };
      }
      if (url.pathname.endsWith("/activity")) return { data: [], nextCursor: null };
      if (url.pathname.endsWith("/wormholes")) return [];
      return undefined;
    },
  });
  return page.then((opened) => ({ ...opened, seen }));
};

describe("a Space on v2", () => {
  for (const view of [wide, narrow, phone])
    for (const [address, state] of [
      ["/app/spaces/Space1?view=list", "usual"],
      ["/app/spaces/Space1?view=list", "worst"],
      ["/app/spaces/Space1?view=table", "usual"],
      ["/app/spaces/Space1?view=kanban", "usual"],
      ["/app/spaces/Space1?view=list&item=Item05", "usual"],
      ["/app/spaces/Space1?view=list", "empty"],
    ] as const)
      test(`${view.name} ${address.split("?")[1]} ${state}: keeps the v2 rules and shows no loading on the first picture`, async () => {
        const { context, tab, errors } = await open(view, address, state);
        try {
          expect(await layoutProblems(tab)).toEqual([]);
          expect(await tab.locator('[data-k2-part="Loading"]').count()).toBe(0);
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }, 60_000);

  test("1,000 items stay one page of 50 rows, ready at once", async () => {
    const started = performance.now();
    const { context, tab, errors } = await open(wide, "/app/spaces/Space1?view=list&groupBy=none", "huge");
    try {
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(await tab.locator('[data-k2-part="Row"]').count()).toBe(50);
      expect(await tab.getByText("Page 1 of 20").count()).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a row opens its item beside the list, the address names it, and Back closes it", async () => {
    const { context, tab, errors } = await open(wide, "/app/spaces/Space1?view=list");
    try {
      await tab.getByRole("link", { name: "Count stock on shelf B" }).click();
      await tab.waitForURL(/item=Item05/);
      await tab.locator('[data-k2-part="Pane"][data-detail]').getByText("Count stock on shelf B").first().waitFor();
      await tab.goBack();
      await tab.waitForFunction(() => !location.search.includes("item="));
      await settled(tab);
      expect(await tab.locator('[data-k2-part="Pane"][data-detail]').count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a task is ticked off at the end of its row", async () => {
    const { context, tab, errors, seen } = await open(wide, "/app/spaces/Space1?view=list");
    try {
      await tab.getByRole("checkbox", { name: "Mark complete: Clear out shelf B" }).check();
      await tab.waitForFunction(() => document.body.innerText.includes("Item completed"));
      expect(seen.completed).toEqual([{ completed: true }]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a search in the head writes q into the address and loads the list for it", async () => {
    const { context, tab, errors, seen } = await open(wide, "/app/spaces/Space1?view=table");
    try {
      const search = tab.getByRole("searchbox", { name: "Search items" });
      await search.fill("shelf");
      await search.press("Enter");
      await tab.waitForURL(/q=shelf/);
      expect(seen.views.some((href) => href.includes("q=shelf") && href.includes("view=table"))).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("New task offers the blank task and opens its form", async () => {
    const { context, tab, errors } = await open(wide, "/app/spaces/Space1?view=list");
    try {
      await tab.getByRole("button", { name: "New task" }).first().click();
      await tab
        .getByRole("menuitem", { name: /New task|Blank task/ })
        .first()
        .click();
      await tab.getByRole("dialog").first().waitFor();
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("on the phone an open item is the page, with one way back to the list", async () => {
    const { context, tab, errors } = await open(phone, "/app/spaces/Space1?view=list&item=Item05");
    try {
      const back = tab.locator('[data-k2-part="Back"]');
      await back.waitFor();
      expect(await back.getAttribute("href")).toBe("/app/spaces/Space1?view=list");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);
});
