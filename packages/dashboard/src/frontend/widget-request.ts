import { LOCALE_HEADER } from "@valentinkolb/cloud/shared";

export const DASHBOARD_WIDGET_CONCURRENCY = 8;
export const DASHBOARD_WIDGET_DEADLINE_MS = 500;

export const dashboardWidgetProxyUrl = (coreOrigin: string, appId: string, widgetId: string): string =>
  new URL(`/api/widgets/v1/${encodeURIComponent(appId)}/${encodeURIComponent(widgetId)}`, coreOrigin).href;

/** Preserve the authenticated browser session and the one resolved request locale across the server-side widget fan-out. */
export const dashboardWidgetRequestHeaders = (cookie: string, locale: string): Headers => {
  const headers = new Headers({ [LOCALE_HEADER]: locale });
  if (cookie) headers.set("Cookie", cookie);
  return headers;
};

/**
 * Run widget requests with stable registry order and bounded fan-out.
 *
 * The caller owns one request-wide deadline signal. Passing that same signal
 * to every worker keeps total dashboard latency bounded even when widgets are
 * queued behind the concurrency limit.
 */
export const mapDashboardWidgetsBounded = async <T, R>(
  widgets: readonly T[],
  signal: AbortSignal,
  run: (widget: T, signal: AbortSignal) => Promise<R>,
  concurrency = DASHBOARD_WIDGET_CONCURRENCY,
): Promise<R[]> => {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError("Widget concurrency must be a positive integer");

  const results = new Array<R>(widgets.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, widgets.length) }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        const widget = widgets[index];
        if (widget === undefined) return;
        results[index] = await run(widget, signal);
      }
    }),
  );
  return results;
};
