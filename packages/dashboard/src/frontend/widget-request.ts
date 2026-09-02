import { LOCALE_HEADER } from "@valentinkolb/cloud/shared";

export const DASHBOARD_WIDGET_CONCURRENCY = 8;
export const DASHBOARD_WIDGET_DEADLINE_MS = 500;

export const dashboardWidgetPageBudgetMs = (count: number): number =>
  Math.ceil(count / DASHBOARD_WIDGET_CONCURRENCY) * DASHBOARD_WIDGET_DEADLINE_MS;

export const isDashboardWidgetTimeout = (error: unknown): boolean =>
  error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");

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
 * Each started widget gets 500 ms; the caller's page deadline is derived from
 * the number of worker waves. More slow widgets can increase total SSR time,
 * but queued widgets do not lose their entire budget to an earlier wave.
 */
export const mapDashboardWidgetsBounded = async <T, R>(
  widgets: readonly T[],
  signal: AbortSignal,
  run: (widget: T, signal: AbortSignal) => Promise<R>,
  concurrency = DASHBOARD_WIDGET_CONCURRENCY,
): Promise<Array<R | undefined>> => {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError("Widget concurrency must be a positive integer");

  const results = new Array<R | undefined>(widgets.length).fill(undefined);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, widgets.length) }, async () => {
      while (true) {
        if (signal.aborted) return;
        const index = nextIndex;
        nextIndex += 1;
        const widget = widgets[index];
        if (widget === undefined) return;
        const widgetSignal = AbortSignal.any([signal, AbortSignal.timeout(DASHBOARD_WIDGET_DEADLINE_MS)]);
        results[index] = await run(widget, widgetSignal);
      }
    }),
  );
  return results;
};
