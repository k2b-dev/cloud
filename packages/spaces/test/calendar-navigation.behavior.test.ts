import { describe, expect, mock, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import { invalidateSpacesData, SPACES_DETAIL_STATE_EVENT } from "../src/frontend/[id]/_components/workspace/workspace-events";
import type { SpacesViewSnapshot } from "../src/frontend/[id]/_components/workspace/workspace-types";

const SPACE_ID = "11111111-1111-4111-8111-111111111111";
const BASE = `/app/spaces/${SPACE_ID}?view=calendar&cv=month&cd=2026-08-01`;
/** What a month href loads: its calendar data, in one parameter order for equal data. */
const monthRequest = (date: string) => `/app/spaces/${SPACE_ID}?cd=${date}&cv=month&view=calendar`;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
};

const snapshot = (date: string): Extract<SpacesViewSnapshot, { kind: "calendar" }> => ({
  kind: "calendar",
  view: "month",
  date: `${date}T00:00:00.000Z`,
  filter: { type: "all", assignedTo: "all", priorities: [], columnIds: [], tagIds: [], colorBy: "tag" },
  items: [],
  weather: {},
});

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("Spaces enhanced calendar navigation", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("commits only the latest applied source and restores history after navigation and popstate failures", async () => {
    const dom = createDomTestHarness();
    dom.window.history.replaceState(null, "", BASE);
    const requests: Array<{
      href: string;
      signal: AbortSignal;
      result: ReturnType<typeof deferred<Extract<SpacesViewSnapshot, { kind: "calendar" }>>>;
    }> = [];
    class SpacesViewUnavailableError extends Error {}
    mock.module("../src/frontend/[id]/_components/workspace/view-query", () => ({
      SpacesViewUnavailableError,
      loadSpacesViewSnapshot: (href: string, signal: AbortSignal) => {
        const result = deferred<Extract<SpacesViewSnapshot, { kind: "calendar" }>>();
        requests.push({ href, signal, result });
        return result.promise;
      },
    }));
    const { useSpacesCalendarQuery } = await import("../src/frontend/[id]/_components/workspace/calendar-query");

    let navigation!: ReturnType<typeof useSpacesCalendarQuery>;
    const dispose = render(() => {
      navigation = useSpacesCalendarQuery({
        spaceId: SPACE_ID,
        initialSource: BASE,
        initialSnapshot: snapshot("2026-08-01"),
      });
      return dom.document.createTextNode("");
    }, dom.root);

    const september = `/app/spaces/${SPACE_ID}?view=calendar&cv=month&cd=2026-09-01`;
    const october = `/app/spaces/${SPACE_ID}?view=calendar&cv=month&cd=2026-10-01`;
    navigation.navigateHref(september);
    await flush();
    expect(`${dom.window.location.pathname}${dom.window.location.search}`).toBe(BASE);
    navigation.navigateHref(october);
    await flush();
    expect(requests.map((request) => request.href)).toEqual([monthRequest("2026-09-01"), monthRequest("2026-10-01")]);
    expect(requests[0]!.signal.aborted).toBe(true);
    requests[0]!.result.resolve(snapshot("2026-09-01"));
    await flush();
    expect(`${dom.window.location.pathname}${dom.window.location.search}`).toBe(BASE);
    requests[1]!.result.resolve(snapshot("2026-10-01"));
    await flush();
    expect(`${dom.window.location.pathname}${dom.window.location.search}`).toBe(october);

    const abandonedNovember = `/app/spaces/${SPACE_ID}?view=calendar&cv=month&cd=2026-11-01`;
    navigation.navigateHref(abandonedNovember);
    await flush();
    const abandonedRequest = requests.at(-1)!;
    navigation.navigateHref(october);
    await flush();
    expect(abandonedRequest.signal.aborted).toBe(true);
    expect(`${dom.window.location.pathname}${dom.window.location.search}`).toBe(october);
    const restoredRequest = requests.at(-1)!;
    expect(restoredRequest.href).toBe(monthRequest("2026-10-01"));
    restoredRequest.result.resolve(snapshot("2026-10-01"));
    await flush();

    const detailEvents: string[] = [];
    const onDetail = (event: Event) => detailEvents.push((event as CustomEvent<{ href: string }>).detail.href);
    dom.window.addEventListener("spaces-detail-navigation", onDetail);
    const octoberDetail = `${october}&item=22222222-2222-4222-8222-222222222222`;
    const requestCount = requests.length;
    dom.window.history.pushState(null, "", octoberDetail);
    dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
    await flush();
    expect(requests).toHaveLength(requestCount);
    expect(detailEvents.at(-1)).toBe(octoberDetail);
    dom.window.removeEventListener("spaces-detail-navigation", onDetail);

    const november = `/app/spaces/${SPACE_ID}?view=calendar&cv=month&cd=2026-11-01`;
    navigation.navigateHref(november);
    await flush();
    const novemberRequest = requests.at(-1)!;
    const coverage = invalidateSpacesData(["view"], "4-0");
    await flush();
    novemberRequest.result.resolve(snapshot("2026-11-01"));
    await flush();
    expect(`${dom.window.location.pathname}${dom.window.location.search}`).toBe(octoberDetail);
    const invalidationRequest = requests.at(-1)!;
    expect(invalidationRequest).not.toBe(novemberRequest);
    invalidationRequest.result.resolve(snapshot("2026-11-01"));
    await coverage;
    await flush();
    expect(`${dom.window.location.pathname}${dom.window.location.search}`).toBe(november);

    const december = `/app/spaces/${SPACE_ID}?view=calendar&cv=month&cd=2026-12-01`;
    navigation.navigateHref(december);
    await flush();
    requests.at(-1)!.result.reject(new Error("December unavailable"));
    await flush();
    expect(`${dom.window.location.pathname}${dom.window.location.search}`).toBe(november);

    const january = `/app/spaces/${SPACE_ID}?view=calendar&cv=month&cd=2027-01-01`;
    const rollbackDetailEvents: string[] = [];
    const onRollbackDetail = (event: Event) => rollbackDetailEvents.push((event as CustomEvent<{ href: string }>).detail.href);
    dom.window.addEventListener("spaces-detail-navigation", onRollbackDetail);
    dom.window.history.pushState(null, "", january);
    dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
    await flush();
    requests.at(-1)!.result.reject(new Error("January unavailable"));
    await flush();
    expect(`${dom.window.location.pathname}${dom.window.location.search}`).toBe(november);
    expect(rollbackDetailEvents.at(-1)).toBe(november);
    dom.window.removeEventListener("spaces-detail-navigation", onRollbackDetail);

    // Source changes during live refresh must cover the new source, not reject
    // the queue's acknowledgement and force a document reload.
    requests.at(-1)!.result.resolve(snapshot("2026-11-01"));
    await flush();
    let coverageError: unknown;
    let covered = false;
    const movingCoverage = invalidateSpacesData(["view"], "5-0").then(
      () => {
        covered = true;
      },
      (error) => {
        coverageError = error;
      },
    );
    await flush();
    const oldRefresh = requests.at(-1)!;
    navigation.navigateHref(december);
    await flush();
    expect(oldRefresh.signal.aborted).toBe(true);
    expect(covered).toBe(false);
    expect(coverageError).toBeUndefined();
    const decemberLoad = requests.at(-1)!;
    decemberLoad.result.resolve(snapshot("2026-12-01"));
    await flush();
    // An invalidation arriving during the source read needs its own covering read.
    requests.at(-1)!.result.resolve(snapshot("2026-12-01"));
    await movingCoverage;
    await flush();
    expect(covered).toBe(true);
    expect(coverageError).toBeUndefined();
    expect(dom.window.location.search).toContain("cd=2026-12-01");

    // Details have an independent owner. A newer selection must survive the
    // completion of an older calendar request, including its occurrence.
    navigation.navigateHref(january);
    await flush();
    const januaryLoad = requests.at(-1)!;
    const selectedDecember = `${december}&item=NewSelection&occurrence=NewOccurrence`;
    dom.window.history.pushState(null, "", selectedDecember);
    dom.window.dispatchEvent(new dom.window.CustomEvent(SPACES_DETAIL_STATE_EVENT));
    januaryLoad.result.resolve(snapshot("2027-01-01"));
    await flush();
    expect(dom.window.location.search).toContain("cd=2027-01-01");
    expect(dom.window.location.search).toContain("item=NewSelection");
    expect(dom.window.location.search).toContain("occurrence=NewOccurrence");

    // Closing a detail after a commit must also be reflected in failed history rollback.
    dom.window.history.pushState(null, "", january);
    dom.window.dispatchEvent(new dom.window.CustomEvent(SPACES_DETAIL_STATE_EVENT));
    dom.window.history.pushState(null, "", december);
    dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
    await flush();
    requests.at(-1)!.result.reject(new Error("History unavailable"));
    await flush();
    expect(`${dom.window.location.pathname}${dom.window.location.search}`).toBe(january);

    // Failed Back navigation restores the view, not a newer explicit selection.
    dom.window.history.pushState(null, "", december);
    dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
    await flush();
    dom.window.history.replaceState(null, "", `${december}&item=AfterBack&occurrence=Occurrence`);
    dom.window.dispatchEvent(new dom.window.CustomEvent(SPACES_DETAIL_STATE_EVENT));
    requests.at(-1)!.result.reject(new Error("History failed after selection"));
    await flush();
    expect(`${dom.window.location.pathname}${dom.window.location.search}`).toBe(`${january}&item=AfterBack&occurrence=Occurrence`);

    dispose();
    dom.cleanup();
  });

  test("changes the color choice in the URL without loading or blanking calendar data", async () => {
    const dom = createDomTestHarness();
    dom.window.history.replaceState(null, "", BASE);
    const requests: Array<{ href: string; result: ReturnType<typeof deferred<Extract<SpacesViewSnapshot, { kind: "calendar" }>>> }> = [];
    mock.module("../src/frontend/[id]/_components/workspace/view-query", () => ({
      SpacesViewUnavailableError: class extends Error {},
      loadSpacesViewSnapshot: (href: string) => {
        const result = deferred<Extract<SpacesViewSnapshot, { kind: "calendar" }>>();
        requests.push({ href, result });
        return result.promise;
      },
    }));
    const { useSpacesCalendarQuery } = await import("../src/frontend/[id]/_components/workspace/calendar-query");
    const loaded = { ...snapshot("2026-08-01"), items: [{ id: "Event1" }] } as unknown as Extract<SpacesViewSnapshot, { kind: "calendar" }>;

    let navigation!: ReturnType<typeof useSpacesCalendarQuery>;
    const dispose = render(() => {
      navigation = useSpacesCalendarQuery({ spaceId: SPACE_ID, initialSource: BASE, initialSnapshot: loaded });
      return dom.document.createTextNode("");
    }, dom.root);

    const byPerson = `${BASE}&ccolor=person`;
    navigation.open(byPerson, { replace: true });
    await flush();
    expect(requests).toHaveLength(0);
    expect(navigation.current().filter.colorBy).toBe("person");
    expect(navigation.current().items).toHaveLength(1);
    expect(`${dom.window.location.pathname}${dom.window.location.search}`).toBe(byPerson);

    // A data navigation keeps the choice: the loaded snapshot never carries it, the committed URL does.
    const september = `/app/spaces/${SPACE_ID}?view=calendar&cv=month&cd=2026-09-01&ccolor=person`;
    navigation.navigateHref(september);
    await flush();
    expect(requests.map((request) => request.href)).toEqual([monthRequest("2026-09-01")]);
    expect(navigation.current().filter.colorBy).toBe("person");
    requests[0]!.result.resolve(snapshot("2026-09-01"));
    await flush();
    expect(navigation.current().filter.colorBy).toBe("person");
    expect(`${dom.window.location.pathname}${dom.window.location.search}`).toBe(september);

    // Back to the same data with another choice follows the history entry.
    dom.window.history.pushState(null, "", `/app/spaces/${SPACE_ID}?view=calendar&cv=month&cd=2026-09-01&ccolor=status`);
    dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
    await flush();
    expect(requests).toHaveLength(1);
    expect(navigation.current().filter.colorBy).toBe("status");

    dispose();
    dom.cleanup();
  });

  test("a replacing change during a pending range navigation still adds the range to history", async () => {
    const dom = createDomTestHarness();
    dom.window.history.replaceState(null, "", BASE);
    const requests: Array<{ href: string; result: ReturnType<typeof deferred<Extract<SpacesViewSnapshot, { kind: "calendar" }>>> }> = [];
    mock.module("../src/frontend/[id]/_components/workspace/view-query", () => ({
      SpacesViewUnavailableError: class extends Error {},
      loadSpacesViewSnapshot: (href: string) => {
        const result = deferred<Extract<SpacesViewSnapshot, { kind: "calendar" }>>();
        requests.push({ href, result });
        return result.promise;
      },
    }));
    const { useSpacesCalendarQuery } = await import("../src/frontend/[id]/_components/workspace/calendar-query");

    let navigation!: ReturnType<typeof useSpacesCalendarQuery>;
    const dispose = render(() => {
      navigation = useSpacesCalendarQuery({ spaceId: SPACE_ID, initialSource: BASE, initialSnapshot: snapshot("2026-08-01") });
      return dom.document.createTextNode("");
    }, dom.root);

    // Next month, then a color or filter choice before September has loaded: both replace the URL they would change.
    const entries = dom.window.history.length;
    navigation.navigateHref(`/app/spaces/${SPACE_ID}?view=calendar&cv=month&cd=2026-09-01`);
    await flush();
    const byPerson = `/app/spaces/${SPACE_ID}?view=calendar&cv=month&cd=2026-09-01&ccolor=person`;
    navigation.open(byPerson, { replace: true });
    await flush();
    requests.at(-1)!.result.resolve(snapshot("2026-09-01"));
    await flush();
    expect(`${dom.window.location.pathname}${dom.window.location.search}`).toBe(byPerson);
    // September is a new entry, so Back still returns to August.
    expect(dom.window.history.length).toBe(entries + 1);

    dispose();
    dom.cleanup();
  });

  test("treats equivalent calendar hrefs as one source, so the first color change after a page load loads nothing", async () => {
    const dom = createDomTestHarness();
    const requests: string[] = [];
    mock.module("../src/frontend/[id]/_components/workspace/view-query", () => ({
      SpacesViewUnavailableError: class extends Error {},
      loadSpacesViewSnapshot: (href: string) => {
        requests.push(href);
        return new Promise(() => {});
      },
    }));
    const { useSpacesCalendarQuery } = await import("../src/frontend/[id]/_components/workspace/calendar-query");
    const { buildSpacesItemLinkBaseUrl } = await import("../src/frontend/[id]/_components/workspace/workspace-types");
    const { defaultFilter } = await import("../src/frontend/[id]/_components/filter/types");
    const { defaultCalendarFilter } = await import("../src/frontend/[id]/_components/calendar/filter");
    const loaded = { ...snapshot("2026-08-01"), items: [{ id: "Event1" }] } as unknown as Extract<SpacesViewSnapshot, { kind: "calendar" }>;
    // The page's base URL comes from the workspace builder: the view only when it overrides the saved one, then the filters.
    const pageBase = (calendarFilter: typeof defaultCalendarFilter, hasViewOverride: boolean) =>
      buildSpacesItemLinkBaseUrl({
        baseSpaceUrl: `/app/spaces/${SPACE_ID}`,
        currentView: "calendar",
        filter: defaultFilter,
        hasViewOverride,
        calendarView: "month",
        calendarDate: "2026-08-01T00:00:00.000Z",
        calendarFilter,
        dateConfig: { timeZone: "UTC" },
      });
    // The calendar's own links always name the view and write the filters after it.
    const cases = [
      { base: pageBase(defaultCalendarFilter, false), next: `/app/spaces/${SPACE_ID}?cv=month&cd=2026-08-01&view=calendar&ccolor=person` },
      {
        base: pageBase({ ...defaultCalendarFilter, type: "task" }, true),
        next: `/app/spaces/${SPACE_ID}?cv=month&cd=2026-08-01&view=calendar&ctype=task&ccolor=person`,
      },
    ];
    expect(cases.map(({ base }) => base)).toEqual([
      `/app/spaces/${SPACE_ID}?cv=month&cd=2026-08-01`,
      `/app/spaces/${SPACE_ID}?cv=month&cd=2026-08-01&ctype=task&view=calendar`,
    ]);

    for (const { base, next } of cases) {
      dom.window.history.replaceState(null, "", base);
      let navigation!: ReturnType<typeof useSpacesCalendarQuery>;
      const dispose = render(() => {
        navigation = useSpacesCalendarQuery({ spaceId: SPACE_ID, initialSource: base, initialSnapshot: loaded });
        return dom.document.createTextNode("");
      }, dom.root);
      navigation.open(next, { replace: true });
      await flush();
      expect(requests).toEqual([]);
      expect(navigation.pending()).toBe(false);
      expect(navigation.current().items).toHaveLength(1);
      expect(navigation.current().filter.colorBy).toBe("person");
      expect(`${dom.window.location.pathname}${dom.window.location.search}`).toBe(next);
      dispose();
    }
    dom.cleanup();
  });
});
