import { describe, expect, mock, test } from "bun:test";
import { createComponent, onCleanup } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

const SPACE_ID = "11111111-1111-4111-8111-111111111111";
const SERIES_ID = "22222222-2222-4222-8222-222222222222";
const OVERRIDE_ID = "33333333-3333-4333-8333-333333333333";
const BASE = `/app/spaces/${SPACE_ID}?view=list`;

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

let detailGet: () => Promise<Response> = async () => new Response(null, { status: 500 });
let panelMounts = 0;
let panelDisposals = 0;
if (!isServer) {
  mock.module("@/api/client", () => ({
    apiClient: {
      [":id"]: {
        items: { [":itemId"]: { detail: { $get: () => detailGet() } } },
      },
    },
  }));
  mock.module("../src/frontend/[id]/_components/detail/ItemDetailPanel", () => ({
    default: () => {
      panelMounts += 1;
      onCleanup(() => (panelDisposals += 1));
      return null;
    },
  }));
}
let ItemDetailRoute: typeof import("../src/frontend/[id]/_components/detail/ItemDetailRoute.island").default;

const detail = (itemId: string, override = false) =>
  ({
    item: { id: itemId },
    comments: { items: [], page: 1, perPage: 50, total: 0, hasNext: false },
    commentTarget: { itemId, recurrenceId: override ? "2026-08-10T10:00:00.000Z" : null },
    recurringContext: override
      ? {
          isOverride: true,
          seriesItemId: SERIES_ID,
          recurrenceId: "2026-08-10T10:00:00.000Z",
        }
      : null,
  }) as never;

describe("Spaces detail navigation", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("loads an unresolved SSR selection and removes a confirmed missing item from the URL", async () => {
    const requests: Array<ReturnType<typeof deferred<Response>>> = [];
    detailGet = () => {
      const request = deferred<Response>();
      requests.push(request);
      return request.promise;
    };
    const dom = createDomTestHarness();
    ItemDetailRoute ??= (await import("../src/frontend/[id]/_components/detail/ItemDetailRoute.island")).default;
    const href = `${BASE}&item=${SERIES_ID}`;
    dom.window.history.replaceState(null, "", href);

    const dispose = render(
      () =>
        createComponent(ItemDetailRoute, {
          spaceId: SPACE_ID,
          initialSource: href,
          currentUserId: "user",
          columns: [],
          tags: [],
          wormholes: [],
          initialDetail: null,
          canWrite: false,
          mailIntegrationAvailable: false,
        }),
      dom.root,
    );
    await flush();
    expect(requests).toHaveLength(1);
    requests[0]!.resolve(new Response(null, { status: 404 }));
    await flush();
    expect(`${dom.window.location.pathname}${dom.window.location.search}`).toBe(BASE);

    dispose();
    dom.cleanup();
  });

  test("replaces an SSR occurrence URL with its canonical override without another read", async () => {
    const requests: unknown[] = [];
    detailGet = async () => {
      requests.push({});
      return new Response(null, { status: 500 });
    };
    const dom = createDomTestHarness();
    ItemDetailRoute ??= (await import("../src/frontend/[id]/_components/detail/ItemDetailRoute.island")).default;
    const occurrence = "2026-08-10T10%3A00%3A00.000Z";
    const requested = `${BASE}&item=${SERIES_ID}&occurrence=${occurrence}`;
    const canonical = `${BASE}&item=${OVERRIDE_ID}&occurrence=${occurrence}`;
    dom.window.history.replaceState(null, "", requested);

    const dispose = render(
      () =>
        createComponent(ItemDetailRoute, {
          spaceId: SPACE_ID,
          initialSource: requested,
          currentUserId: "user",
          columns: [],
          tags: [],
          wormholes: [],
          initialDetail: detail(OVERRIDE_ID, true),
          canWrite: false,
          mailIntegrationAvailable: false,
        }),
      dom.root,
    );
    await flush();
    expect(`${dom.window.location.pathname}${dom.window.location.search}`).toBe(canonical);
    expect(requests).toHaveLength(0);

    dispose();
    dom.cleanup();
  });

  test("keeps the detail panel open while another selected item loads", async () => {
    const requests: Array<ReturnType<typeof deferred<Response>>> = [];
    detailGet = () => {
      const request = deferred<Response>();
      requests.push(request);
      return request.promise;
    };
    const dom = createDomTestHarness();
    ItemDetailRoute ??= (await import("../src/frontend/[id]/_components/detail/ItemDetailRoute.island")).default;
    const initialHref = `${BASE}&item=${SERIES_ID}`;
    const nextHref = `${BASE}&item=${OVERRIDE_ID}`;
    dom.window.history.replaceState(null, "", initialHref);

    const dispose = render(
      () =>
        createComponent(ItemDetailRoute, {
          spaceId: SPACE_ID,
          initialSource: initialHref,
          currentUserId: "user",
          columns: [],
          tags: [],
          wormholes: [],
          initialDetail: detail(SERIES_ID),
          canWrite: false,
          mailIntegrationAvailable: false,
        }),
      dom.root,
    );
    const panel = dom.document.getElementById("k2b-workspace-detail-space-detail-panel") as HTMLElement;
    expect(panel.hidden).toBe(false);

    dom.window.dispatchEvent(
      new dom.window.CustomEvent("spaces-detail-navigation", {
        detail: { href: nextHref, history: "push" },
      }),
    );
    await flush();

    expect(requests).toHaveLength(1);
    expect(panel.hidden).toBe(false);
    expect(panel.textContent).toContain("Loading item details");

    requests[0]!.resolve(Response.json(detail(OVERRIDE_ID)));
    await flush();
    expect(panel.hidden).toBe(false);

    dom.window.dispatchEvent(
      new dom.window.CustomEvent("spaces-detail-navigation", {
        detail: { href: BASE, history: "push" },
      }),
    );
    await flush();
    expect(panel.hidden).toBe(true);

    dispose();
    dom.cleanup();
  });

  test("refreshes the selected item without remounting its detail editor", async () => {
    panelMounts = 0;
    panelDisposals = 0;
    detailGet = async () => Response.json(detail(SERIES_ID));
    const dom = createDomTestHarness();
    ItemDetailRoute ??= (await import("../src/frontend/[id]/_components/detail/ItemDetailRoute.island")).default;
    const href = `${BASE}&item=${SERIES_ID}`;
    dom.window.history.replaceState(null, "", href);
    const dispose = render(
      () =>
        createComponent(ItemDetailRoute, {
          spaceId: SPACE_ID,
          initialSource: href,
          currentUserId: "user",
          columns: [],
          tags: [],
          wormholes: [],
          initialDetail: detail(SERIES_ID),
          canWrite: false,
          mailIntegrationAvailable: false,
        }),
      dom.root,
    );
    expect(panelMounts).toBe(1);

    const { invalidateSpacesData } = await import("../src/frontend/[id]/_components/workspace/workspace-events");
    await invalidateSpacesData(["detail"], "5-0", SERIES_ID);
    await flush();
    expect(panelMounts).toBe(1);
    expect(panelDisposals).toBe(0);

    dispose();
    expect(panelDisposals).toBe(1);
    dom.cleanup();
  });
});
