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

let detailGet: (signal?: AbortSignal) => Promise<Response> = async () => new Response(null, { status: 500 });
let panelMounts = 0;
let panelDisposals = 0;
if (!isServer) {
  mock.module("@/api/client", () => ({
    apiClient: {
      [":id"]: {
        items: {
          [":itemId"]: {
            detail: { $get: (_: unknown, options?: { init?: { signal?: AbortSignal } }) => detailGet(options?.init?.signal) },
          },
        },
      },
    },
  }));
  mock.module("../src/frontend/[id]/_components/detail/ItemDetailPanel", () => ({
    default: (props: { baseUrl: string }) => {
      panelMounts += 1;
      onCleanup(() => (panelDisposals += 1));
      return (
        <div>
          <input aria-label="Comment draft" />
          <a href={props.baseUrl}>Close</a>
        </div>
      );
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

  test("keeps the same editor and focused draft when list search updates its navigation URL", async () => {
    panelMounts = 0;
    panelDisposals = 0;
    let reads = 0;
    detailGet = async () => {
      reads += 1;
      return Response.json(detail(SERIES_ID));
    };
    const dom = createDomTestHarness();
    ItemDetailRoute ??= (await import("../src/frontend/[id]/_components/detail/ItemDetailRoute.island")).default;
    const href = `${BASE}&item=${SERIES_ID}`;
    dom.window.history.replaceState({ marker: "preserved" }, "", href);
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
    const input = dom.root.querySelector("input")!;
    input.value = "Unsent comment";
    input.focus();
    const { reconcileSpacesDetailRoute } = await import("../src/frontend/[id]/_components/workspace/workspace-events");
    const searched = `${href}&q=search`;
    dom.window.history.replaceState({ marker: "preserved" }, "", searched);
    reconcileSpacesDetailRoute(searched);
    await flush();
    expect(reads).toBe(0);
    expect(panelMounts).toBe(1);
    expect(panelDisposals).toBe(0);
    expect(dom.root.querySelector("input")).toBe(input);
    expect(input.value).toBe("Unsent comment");
    expect(dom.document.activeElement).toBe(input);
    expect(dom.root.querySelector("a")?.getAttribute("href")).toBe(`${BASE}&q=search`);
    expect(dom.window.history.state).toEqual({ marker: "preserved" });
    dispose();
    dom.cleanup();
  });

  test("a closed detail panel lets ready coverage and subsequent live events complete", async () => {
    const dom = createDomTestHarness();
    ItemDetailRoute ??= (await import("../src/frontend/[id]/_components/detail/ItemDetailRoute.island")).default;
    dom.window.history.replaceState(null, "", BASE);
    let reads = 0;
    detailGet = async () => {
      reads += 1;
      return Response.json(detail(SERIES_ID));
    };
    const dispose = render(
      () =>
        createComponent(ItemDetailRoute, {
          spaceId: SPACE_ID,
          initialSource: BASE,
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
    const { createSpacesLiveCursorQueue, invalidateSpacesData, subscribeToSpacesDataInvalidation } = await import(
      "../src/frontend/[id]/_components/workspace/workspace-events"
    );
    const applied: Array<string | null> = [];
    const failures: Error[] = [];
    const viewReads: Array<string | null> = [];
    const stop = subscribeToSpacesDataInvalidation(["view"], async ({ cursor }) => {
      viewReads.push(cursor);
    });
    const queue = createSpacesLiveCursorQueue({
      invalidate: invalidateSpacesData,
      markApplied: (cursor) => {
        applied.push(cursor);
      },
      onFailure: (error) => {
        failures.push(error);
      },
    });
    await queue(["view", "detail", "wormholes"], "ready");
    await queue(["view", "detail"], "next", SERIES_ID);
    expect(applied).toEqual(["ready", "next"]);
    expect(viewReads).toEqual(["ready", "next"]);
    expect(failures).toEqual([]);
    expect(reads).toBe(0);
    stop();
    dispose();
    dom.cleanup();
  });

  test("live coverage follows a changed selection and resolves when the panel closes", async () => {
    const requests: Array<ReturnType<typeof deferred<Response>> & { signal?: AbortSignal }> = [];
    detailGet = (signal) => {
      const request = { ...deferred<Response>(), signal };
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
          initialDetail: detail(SERIES_ID),
          canWrite: false,
          mailIntegrationAvailable: false,
        }),
      dom.root,
    );
    const { createSpacesLiveCursorQueue, invalidateSpacesData } = await import(
      "../src/frontend/[id]/_components/workspace/workspace-events"
    );
    const applied: Array<string | null> = [];
    const failures: Error[] = [];
    const queue = createSpacesLiveCursorQueue({
      invalidate: invalidateSpacesData,
      markApplied: (cursor) => {
        applied.push(cursor);
      },
      onFailure: (error) => {
        failures.push(error);
      },
    });
    const ready = queue(["view", "detail", "wormholes"], "ready");
    await flush();
    expect(requests).toHaveLength(1);
    dom.window.dispatchEvent(
      new dom.window.CustomEvent("spaces-detail-navigation", { detail: { href: `${BASE}&item=${OVERRIDE_ID}`, history: "push" } }),
    );
    await flush();
    expect(requests[0]?.signal?.aborted).toBe(true);
    expect(applied).toEqual([]);
    dom.window.dispatchEvent(new dom.window.CustomEvent("spaces-detail-navigation", { detail: { href: BASE, history: "push" } }));
    await ready;
    await queue(["view", "detail"], "next", SERIES_ID);
    expect(applied).toEqual(["ready", "next"]);
    expect(failures).toEqual([]);
    expect(requests.every((request) => request.signal?.aborted)).toBe(true);
    for (const request of requests) request.resolve(Response.json(detail(OVERRIDE_ID)));
    await flush();
    expect(`${dom.window.location.pathname}${dom.window.location.search}`).toBe(BASE);
    dispose();
    dom.cleanup();
  });

  test("a view URL change neither aborts nor acknowledges an unfinished detail refresh", async () => {
    const requests: Array<ReturnType<typeof deferred<Response>> & { signal?: AbortSignal }> = [];
    detailGet = (signal) => {
      const request = { ...deferred<Response>(), signal };
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
          initialDetail: detail(SERIES_ID),
          canWrite: false,
          mailIntegrationAvailable: false,
        }),
      dom.root,
    );
    const { invalidateSpacesData, reconcileSpacesDetailRoute } = await import(
      "../src/frontend/[id]/_components/workspace/workspace-events"
    );
    let applied = false;
    const coverage = invalidateSpacesData(["detail"], "ready").then(() => {
      applied = true;
    });
    await flush();
    const next = `${href}&q=next`;
    dom.window.history.replaceState(null, "", next);
    reconcileSpacesDetailRoute(next);
    await flush();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.signal?.aborted).toBe(false);
    expect(applied).toBe(false);
    requests[0]!.resolve(Response.json(detail(SERIES_ID)));
    await coverage;
    expect(applied).toBe(true);
    expect(`${dom.window.location.pathname}${dom.window.location.search}`).toBe(next);
    dispose();
    dom.cleanup();
  });

  test("a view commit preserves a pending item selection but real Back navigation cancels it", async () => {
    const requests: Array<ReturnType<typeof deferred<Response>> & { signal?: AbortSignal }> = [];
    detailGet = (signal) => {
      const request = { ...deferred<Response>(), signal };
      requests.push(request);
      return request.promise;
    };
    const dom = createDomTestHarness();
    ItemDetailRoute ??= (await import("../src/frontend/[id]/_components/detail/ItemDetailRoute.island")).default;
    const initial = `${BASE}&item=${SERIES_ID}`;
    dom.window.history.replaceState(null, "", initial);
    const dispose = render(
      () =>
        createComponent(ItemDetailRoute, {
          spaceId: SPACE_ID,
          initialSource: initial,
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
    const { reconcileSpacesDetailRoute } = await import("../src/frontend/[id]/_components/workspace/workspace-events");
    dom.window.dispatchEvent(
      new dom.window.CustomEvent("spaces-detail-navigation", { detail: { href: `${BASE}&item=${OVERRIDE_ID}`, history: "push" } }),
    );
    await flush();
    const searched = `${initial}&q=next`;
    dom.window.history.replaceState(null, "", searched);
    reconcileSpacesDetailRoute(searched);
    await flush();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.signal?.aborted).toBe(false);
    requests[0]!.resolve(Response.json(detail(OVERRIDE_ID)));
    await flush();
    expect(new URL(dom.window.location.href).searchParams.get("item")).toBe(OVERRIDE_ID);
    expect(new URL(dom.window.location.href).searchParams.get("q")).toBe("next");
    expect(dom.root.querySelector("a")?.getAttribute("href")).toBe(`${BASE}&q=next`);

    dom.window.dispatchEvent(new dom.window.CustomEvent("spaces-detail-navigation", { detail: { href: searched, history: "push" } }));
    await flush();
    dom.window.history.replaceState(null, "", `${BASE}&q=back`);
    dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
    await flush();
    expect(requests[1]?.signal?.aborted).toBe(true);
    requests[1]!.resolve(Response.json(detail(SERIES_ID)));
    await flush();
    expect(`${dom.window.location.pathname}${dom.window.location.search}`).toBe(`${BASE}&q=back`);
    expect(dom.document.getElementById("k2b-workspace-detail-space-detail-panel")?.hidden).toBe(true);
    dispose();
    dom.cleanup();
  });

  test("a calendar commit clearing its old item preserves a newer pending item click", async () => {
    const request = deferred<Response>();
    let signal: AbortSignal | undefined;
    let reads = 0;
    detailGet = (nextSignal) => {
      reads += 1;
      signal = nextSignal;
      return request.promise;
    };
    const dom = createDomTestHarness();
    ItemDetailRoute ??= (await import("../src/frontend/[id]/_components/detail/ItemDetailRoute.island")).default;
    const initial = `/app/spaces/${SPACE_ID}?view=calendar&date=2026-09-01&item=${SERIES_ID}`;
    dom.window.history.replaceState(null, "", initial);
    const dispose = render(
      () =>
        createComponent(ItemDetailRoute, {
          spaceId: SPACE_ID,
          initialSource: initial,
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
    const { reconcileSpacesDetailRoute } = await import("../src/frontend/[id]/_components/workspace/workspace-events");
    dom.window.dispatchEvent(
      new dom.window.CustomEvent("spaces-detail-navigation", {
        detail: { href: initial.replace(SERIES_ID, OVERRIDE_ID), history: "push" },
      }),
    );
    await flush();
    const october = `/app/spaces/${SPACE_ID}?view=calendar&date=2026-10-01`;
    dom.window.history.replaceState(null, "", october);
    reconcileSpacesDetailRoute(october);
    await flush();
    expect(reads).toBe(1);
    expect(signal?.aborted).toBe(false);
    request.resolve(Response.json(detail(OVERRIDE_ID)));
    await flush();
    expect(`${dom.window.location.pathname}${dom.window.location.search}`).toBe(`${october}&item=${OVERRIDE_ID}`);
    expect(dom.root.querySelector("a")?.getAttribute("href")).toBe(october);
    dispose();
    dom.cleanup();
  });
});
