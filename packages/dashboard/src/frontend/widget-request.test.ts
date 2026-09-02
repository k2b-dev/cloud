import { describe, expect, spyOn, test } from "bun:test";
import {
  DASHBOARD_WIDGET_CONCURRENCY,
  DASHBOARD_WIDGET_DEADLINE_MS,
  dashboardWidgetPageBudgetMs,
  dashboardWidgetProxyUrl,
  dashboardWidgetRequestHeaders,
  isDashboardWidgetTimeout,
  mapDashboardWidgetsBounded,
} from "./widget-request";

describe("dashboard widget request metadata", () => {
  test("targets the Core-owned widget proxy", () => {
    expect(dashboardWidgetProxyUrl("http://app-core:3000", "gateway-ops", "health/errors")).toBe(
      "http://app-core:3000/api/widgets/v1/gateway-ops/health%2Ferrors",
    );
  });
  test("forwards the resolved locale alongside the authenticated session", () => {
    const headers = dashboardWidgetRequestHeaders("session=abc", "de-CH");
    expect(headers.get("x-cloud-locale")).toBe("de-CH");
    expect(headers.get("Cookie")).toBe("session=abc");
    expect(headers.get("Accept-Language")).toBeNull();
  });

  test("forwards locale without inventing a session", () => {
    const headers = dashboardWidgetRequestHeaders("", "en");
    expect(headers.get("x-cloud-locale")).toBe("en");
    expect(headers.get("Cookie")).toBeNull();
  });
});

describe("dashboard widget fan-out", () => {
  test("derives the total page budget from the worker wave count", () => {
    expect([0, 1, 8, 9, 17].map(dashboardWidgetPageBudgetMs)).toEqual([0, 500, 500, 1_000, 1_500]);
  });

  test("recognizes native timeout and legacy abort errors", () => {
    expect(isDashboardWidgetTimeout(new DOMException("expired", "TimeoutError"))).toBeTrue();
    expect(isDashboardWidgetTimeout(new DOMException("aborted", "AbortError"))).toBeTrue();
    expect(isDashboardWidgetTimeout(new Error("failed"))).toBeFalse();
  });

  test("preserves registry order while bounding concurrency", async () => {
    const widgets = Array.from({ length: DASHBOARD_WIDGET_CONCURRENCY * 3 }, (_, index) => index);
    let active = 0;
    let peak = 0;

    const results = await mapDashboardWidgetsBounded(widgets, new AbortController().signal, async (widget) => {
      active += 1;
      peak = Math.max(peak, active);
      await Bun.sleep(widget % 3);
      active -= 1;
      return `widget-${widget}`;
    });

    expect(peak).toBe(DASHBOARD_WIDGET_CONCURRENCY);
    expect(results).toEqual(widgets.map((widget) => `widget-${widget}`));
  });

  test("gives queued widgets a new per-start deadline after earlier widgets expire", async () => {
    const timeoutSignal = AbortSignal.timeout.bind(AbortSignal);
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() => timeoutSignal(5));
    const seenSignals = new Set<AbortSignal>();
    const page = new AbortController();
    try {
      const results = await mapDashboardWidgetsBounded(
        Array.from({ length: DASHBOARD_WIDGET_CONCURRENCY + 2 }, (_, index) => index),
        page.signal,
        async (_widget, workerSignal) => {
          seenSignals.add(workerSignal);
          expect(workerSignal.aborted).toBeFalse();
          await new Promise<void>((resolve) => workerSignal.addEventListener("abort", () => resolve(), { once: true }));
          return isDashboardWidgetTimeout(workerSignal.reason);
        },
      );

      expect(seenSignals.size).toBe(DASHBOARD_WIDGET_CONCURRENCY + 2);
      expect(timeout).toHaveBeenCalledTimes(DASHBOARD_WIDGET_CONCURRENCY + 2);
      expect(timeout).toHaveBeenCalledWith(DASHBOARD_WIDGET_DEADLINE_MS);
      expect(results).toEqual(Array(DASHBOARD_WIDGET_CONCURRENCY + 2).fill(true));
      expect(page.signal.aborted).toBeFalse();
    } finally {
      timeout.mockRestore();
    }
  });

  test("does not start queued I/O after the page aborts", async () => {
    const page = new AbortController();
    const started: number[] = [];
    const results = await mapDashboardWidgetsBounded(
      Array.from({ length: DASHBOARD_WIDGET_CONCURRENCY + 2 }, (_, index) => index),
      page.signal,
      async (widget) => {
        started.push(widget);
        if (widget === DASHBOARD_WIDGET_CONCURRENCY - 1) page.abort();
        return widget;
      },
    );
    expect(started).toEqual(Array.from({ length: DASHBOARD_WIDGET_CONCURRENCY }, (_, index) => index));
    expect(results.slice(DASHBOARD_WIDGET_CONCURRENCY)).toEqual([undefined, undefined]);
    let called = false;
    await mapDashboardWidgetsBounded([1], page.signal, async () => {
      called = true;
    });
    expect(called).toBeFalse();
  });

  test("rejects an invalid concurrency limit", async () => {
    expect(mapDashboardWidgetsBounded([], new AbortController().signal, async () => null, 0)).rejects.toThrow(
      "Widget concurrency must be a positive integer",
    );
  });
});
