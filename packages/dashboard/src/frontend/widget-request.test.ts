import { describe, expect, test } from "bun:test";
import {
  DASHBOARD_WIDGET_CONCURRENCY,
  dashboardWidgetProxyUrl,
  dashboardWidgetRequestHeaders,
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

  test("shares one deadline signal across queued workers", async () => {
    const signal = AbortSignal.timeout(10);
    const seenSignals = new Set<AbortSignal>();
    const results = await mapDashboardWidgetsBounded(
      Array.from({ length: DASHBOARD_WIDGET_CONCURRENCY + 2 }, (_, index) => index),
      signal,
      async (widget, workerSignal) => {
        seenSignals.add(workerSignal);
        if (widget < DASHBOARD_WIDGET_CONCURRENCY) await Bun.sleep(20);
        return workerSignal.aborted;
      },
    );

    expect(seenSignals).toEqual(new Set([signal]));
    expect(results.slice(DASHBOARD_WIDGET_CONCURRENCY)).toEqual([true, true]);
  });

  test("rejects an invalid concurrency limit", async () => {
    expect(mapDashboardWidgetsBounded([], new AbortController().signal, async () => null, 0)).rejects.toThrow(
      "Widget concurrency must be a positive integer",
    );
  });
});
