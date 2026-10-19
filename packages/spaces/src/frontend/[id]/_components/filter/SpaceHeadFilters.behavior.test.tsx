import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import {
  requestSpacesFilterChange,
  SPACES_ROUTE_FILTER_EVENT,
  SPACES_ROUTE_FILTER_REQUEST_EVENT,
  type SpacesRouteFilterState,
} from "../workspace/workspace-events";

if (isServer) test.skip("head filter bridge uses browser conditions", () => {});
else {
  test("before the route island hydrates, Reset is a document navigation and nothing is lost", async () => {
    const dom = createDomTestHarness();
    const source = "/app/spaces/Space1?view=list&q=ship";
    dom.window.history.replaceState(null, "", source);
    const assigned: string[] = [];
    const assign = dom.window.location.assign;
    dom.window.location.assign = (href: string | URL) => void assigned.push(String(href));
    const changes: unknown[] = [];
    const listen = (event: Event) => changes.push((event as CustomEvent).detail);
    window.addEventListener("spaces-filter-change", listen);
    const { default: SpaceHeadFilters } = await import("./SpaceHeadFilters.island");
    const dispose = render(
      () =>
        createComponent(SpaceHeadFilters, {
          spaceId: "Space1",
          columns: [],
          tags: [],
          currentView: "list",
          initialSource: source,
          initialTotal: 0,
        }),
      dom.root,
    );
    try {
      const reset = Array.from(dom.root.querySelectorAll("a")).find((link) => link.textContent?.includes("Reset"));
      expect(reset).toBeDefined();
      reset!.click();
      expect(changes).toEqual([]);
      expect(assigned).toHaveLength(1);
      expect(new URL(assigned[0]!, "http://localhost").searchParams.get("q")).toBeNull();
    } finally {
      dispose();
      window.removeEventListener("spaces-filter-change", listen);
      dom.window.location.assign = assign;
      dom.cleanup();
    }
  });

  for (const currentView of ["list", "kanban"] as const) {
    for (const routeFirst of [true, false]) {
      test(`${currentView}: head and route handshake and apply/reset filters (${routeFirst ? "route" : "head"} hydrates first)`, async () => {
        const dom = createDomTestHarness();
        const source = `/app/spaces/Space1?view=${currentView}`;
        dom.window.history.replaceState(null, "", source);
        const originalCss = Object.getOwnPropertyDescriptor(globalThis, "CSS");
        Object.defineProperty(globalThis, "CSS", { configurable: true, value: dom.window.CSS });
        const originalFetch = globalThis.fetch;
        const requests: { href: string; resolve: (response: Response) => void }[] = [];
        globalThis.fetch = Object.assign(
          (input: RequestInfo | URL) => {
            const url = new URL(String(input), "http://localhost");
            if (!url.pathname.endsWith("/workspace/view")) throw new Error(`Unexpected request ${url.pathname}`);
            return new Promise<Response>((resolve) => requests.push({ href: url.searchParams.get("href") ?? "", resolve }));
          },
          { preconnect: originalFetch.preconnect },
        );
        const { default: SpaceHeadFilters } = await import("./SpaceHeadFilters.island");
        const { default: SpacesListRoute } = await import("../workspace/SpacesListRoute.island");
        const { default: SpacesKanbanRoute } = await import("../workspace/SpacesKanbanRoute.island");
        const headRoot = dom.document.createElement("div");
        const routeRoot = dom.document.createElement("div");
        dom.root.append(headRoot, routeRoot);
        const initial = { items: [], total: 0, page: 1, pageSize: 50, totalPages: 1 };
        const { defaultFilter } = await import("./types");
        const mountHead = () =>
          render(
            () =>
              createComponent(SpaceHeadFilters, {
                spaceId: "Space1",
                columns: [],
                tags: [],
                currentView,
                initialSource: source,
                initialTotal: 0,
              }),
            headRoot,
          );
        const mountRoute = () =>
          render(
            () =>
              currentView === "kanban"
                ? createComponent(SpacesKanbanRoute, {
                    spaceId: "Space1",
                    baseUrl: source,
                    columns: [],
                    tags: [],
                    wormholes: [],
                    initialBuckets: [],
                    foldedColumns: [],
                    selectedItemId: "",
                    canWrite: false,
                    currentUserId: "User01",
                  })
                : createComponent(SpacesListRoute, {
                    spaceId: "Space1",
                    currentView,
                    columns: [],
                    tags: [],
                    filter: defaultFilter,
                    initialItemsResult: initial,
                    initialSelectedItemId: "",
                    itemLinkBaseUrl: source,
                    paginationBaseUrl: `${source}&page=`,
                    canWrite: false,
                    currentUserId: "User01",
                  }),
            routeRoot,
          );
        const states: SpacesRouteFilterState[] = [];
        const receive = (event: Event) => {
          if (event instanceof CustomEvent) states.push(event.detail);
        };
        window.addEventListener(SPACES_ROUTE_FILTER_EVENT, receive);
        const disposeFirst = routeFirst ? mountRoute() : mountHead();
        const disposeSecond = routeFirst ? mountHead() : mountRoute();
        const settle = () => Bun.sleep(30);
        const click = (label: string) => {
          const button = Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find(
            (element) => element.textContent?.trim() === label,
          );
          expect(button).toBeDefined();
          button!.click();
        };
        try {
          await settle();
          expect(states.at(-1)).toMatchObject({ view: currentView, busy: false });
          expect(headRoot.textContent).not.toContain("Reset");
          click("Priority");
          click("High");
          await settle();
          expect(requests).toHaveLength(1);
          expect(requests[0]!.href).toContain("priority=high");
          expect(states.at(-1)).toMatchObject({ busy: true });
          expect(headRoot.textContent).toContain("Priority: High");
          expect(headRoot.textContent).toContain("Reset");
          requests[0]!.resolve(
            Response.json(
              currentView === "kanban"
                ? { kind: "kanban", buckets: [], wormholes: [] }
                : { kind: "list", currentView, itemsResult: initial },
            ),
          );
          await settle();
          expect(dom.window.location.search).toContain("priority=high");
          expect(states.at(-1)).toMatchObject({ busy: false });
          if (currentView === "list") expect(headRoot.querySelector("[data-spaces-filter-count]")?.textContent).toContain("0 items");
          else expect(headRoot.querySelector("[data-spaces-filter-count]")).toBeNull();
          dom.document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          headRoot.querySelector<HTMLAnchorElement>('a[aria-label="Reset"]')!.click();
          await settle();
          expect(requests).toHaveLength(2);
          expect(requests[1]!.href).not.toContain("priority");
          expect(states.at(-1)?.searchReset).toBe(1);
          requests[1]!.resolve(
            Response.json(
              currentView === "kanban"
                ? { kind: "kanban", buckets: [], wormholes: [] }
                : { kind: "list", currentView, itemsResult: initial },
            ),
          );
          await settle();
          expect(headRoot.textContent).not.toContain("Reset");
          // A direct controller request has the same owner and response path.
          requestSpacesFilterChange({ href: `${source}&q=ship` });
          await settle();
          expect(requests[2]!.href).toContain("q=ship");
          requests[2]!.resolve(Response.json({ message: "Offline" }, { status: 503 }));
          await settle();
          expect(routeRoot.querySelector('[role="alert"]')?.textContent).toContain("Retry");
          window.dispatchEvent(new CustomEvent(SPACES_ROUTE_FILTER_REQUEST_EVENT));
          expect(states.at(-1)?.requestedSource).toContain("q=ship");
        } finally {
          disposeSecond();
          disposeFirst();
          window.removeEventListener(SPACES_ROUTE_FILTER_EVENT, receive);
          globalThis.fetch = originalFetch;
          if (originalCss) Object.defineProperty(globalThis, "CSS", originalCss);
          else Reflect.deleteProperty(globalThis, "CSS");
          dom.cleanup();
        }
      });
    }
  }
}
