import { describe, expect, mock, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import { invalidateSpacesData } from "../src/frontend/[id]/_components/workspace/workspace-events";

const SPACE_ID = "11111111-1111-4111-8111-111111111111";

// A view the API keeps rejecting although SSR renders it: every load reloads
// automatically unless the reload is bounded.
class SpacesViewUnavailableError extends Error {}
if (!isServer) {
  mock.module("../src/frontend/[id]/_components/workspace/view-query", () => ({
    SpacesViewUnavailableError,
    loadSpacesViewSnapshot: async () => {
      throw new SpacesViewUnavailableError("Workspace access changed");
    },
  }));
}

const settle = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  await Bun.sleep(5);
};

/** Mounts the route once per simulated page load; sessionStorage survives each reload. */
const expectOneReloadAcrossLoads = async (
  dom: ReturnType<typeof createDomTestHarness>,
  path: string,
  mount: () => () => void,
  domain: "view" | "wormholes",
) => {
  dom.window.history.replaceState(null, "", path);
  const reload = spyOn(dom.window.location, "reload").mockImplementation(() => {});
  try {
    for (let load = 0; load < 3; load += 1) {
      const dispose = mount();
      await invalidateSpacesData([domain]).catch(() => undefined);
      await settle();
      dispose();
    }
    expect(reload).toHaveBeenCalledTimes(1);
  } finally {
    reload.mockRestore();
    dom.cleanup();
  }
};

describe("Spaces unavailable-view reloads", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("the list view reloads at most once for a view that stays unavailable", async () => {
    const dom = createDomTestHarness();
    const { useSpacesListQuery } = await import("../src/frontend/[id]/_components/workspace/list-query");
    const path = `/app/spaces/${SPACE_ID}?view=list`;
    await expectOneReloadAcrossLoads(
      dom,
      path,
      () =>
        render(() => {
          useSpacesListQuery({
            initialSource: path,
            initialItemsResult: { items: [], page: 1, pageSize: 30, totalPages: 1, total: 0 },
            currentView: "list",
          });
          return dom.document.createTextNode("");
        }, dom.root),
      "view",
    );
  });

  test("the calendar view reloads at most once for a view that stays unavailable", async () => {
    const dom = createDomTestHarness();
    const { useSpacesCalendarQuery } = await import("../src/frontend/[id]/_components/workspace/calendar-query");
    const path = `/app/spaces/${SPACE_ID}?view=calendar&cv=month&cd=2026-08-01`;
    await expectOneReloadAcrossLoads(
      dom,
      path,
      () =>
        render(() => {
          useSpacesCalendarQuery({
            spaceId: SPACE_ID,
            initialSource: path,
            initialSnapshot: {
              kind: "calendar",
              view: "month",
              date: "2026-08-01T00:00:00.000Z",
              filter: { type: "all", assignedTo: "all", priorities: [], columnIds: [], tagIds: [] },
              items: [],
              weather: {},
            },
          });
          return dom.document.createTextNode("");
        }, dom.root),
      "view",
    );
  });

  test("the Kanban view reloads at most once for a view that stays unavailable", async () => {
    const dom = createDomTestHarness();
    const { default: SpacesKanbanRoute } = await import("../src/frontend/[id]/_components/workspace/SpacesKanbanRoute.island");
    const path = `/app/spaces/${SPACE_ID}?view=kanban`;
    await expectOneReloadAcrossLoads(
      dom,
      path,
      () =>
        render(
          () =>
            createComponent(SpacesKanbanRoute, {
              spaceId: SPACE_ID,
              baseUrl: path,
              columns: [],
              tags: [],
              wormholes: [],
              initialBuckets: [],
              selectedItemId: "",
              canWrite: false,
              currentUserId: "77777777-7777-4777-8777-777777777777",
            }),
          dom.root,
        ),
      "wormholes",
    );
  });
});
