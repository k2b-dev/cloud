import type { Route } from "playwright";
import type { Api, createScreenBrowser, View } from "../../../../../test/v2-screen-browser";
import { SPACE_NOW, type SpaceFixtureState, spaceScreenProps } from "./space-screen.fixture";

export type Seen = { views: string[]; completed: unknown[] };
export type OpenOptions = {
  /** The server answers 503 to every list or board load that searches. */
  failSearch?: boolean;
  /** Answers first; `undefined` falls through to the fixture's own answers. */
  api?: Api;
};

/**
 * Opens a Space on v2 in the Space screen harness. The test stands in for the server: the page renders the fixture
 * state for the address, and the API answers the view, the detail, completion and the activity from the same fixture.
 */
export const spaceOpener =
  (screen: ReturnType<typeof createScreenBrowser>) =>
  (view: View, address: string, state: SpaceFixtureState = "usual", options: OpenOptions = {}) => {
    const seen: Seen = { views: [], completed: [] };
    const page = screen.open(view, address, {
      pages: ["/app/spaces/Space1"],
      now: SPACE_NOW,
      state,
      api: async (url: URL, route: Route) => {
        const own = await options.api?.(url, route);
        if (own !== undefined) return own;
        if (url.pathname === "/api/spaces/workspace/view") {
          const href = url.searchParams.get("href") ?? "";
          seen.views.push(href);
          if (options.failSearch && href.includes("q=")) return Response.json({ message: "Service unavailable" }, { status: 503 });
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
