import { describe, expect, mock, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import { invalidateSpacesData, SPACES_DETAIL_STATE_EVENT } from "../src/frontend/[id]/_components/workspace/workspace-events";
import type { SpacesViewSnapshot } from "../src/frontend/[id]/_components/workspace/workspace-types";

const SPACE_ID = "11111111-1111-4111-8111-111111111111";
const BASE = `/app/spaces/${SPACE_ID}?view=calendar&cv=month&cd=2026-08-01`;

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
  filter: { type: "all", assignedTo: "all", priorities: [], columnIds: [], tagIds: [] },
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
    expect(requests.map((request) => request.href)).toEqual([september, october]);
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
    expect(restoredRequest.href).toBe(october);
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
});
