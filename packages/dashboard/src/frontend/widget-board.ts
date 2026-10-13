import { streamWidgets, type WidgetResponse, type WidgetStreamLine } from "@k2b/cloud/browser/widgets";

import { type DashboardBoardEntry, widgetRequestSettings } from "../shared";

/**
 * What one widget frame shows. A frame starts as `loading` and settles when its widget answers; a failed widget can be
 * asked again on its own, and a widget asked again quietly keeps showing what it showed until the new answer arrives.
 */
export type DashboardTileState =
  | { status: "loading" }
  | { status: "ok"; widget: WidgetResponse }
  | { status: "empty" | "forbidden" | "timeout" | "error" };

export type DashboardTiles = Record<string, DashboardTileState>;

/** The state a widget line settles its frame in. */
export const tileFromLine = (line: Extract<WidgetStreamLine, { type: "widget" }>): DashboardTileState =>
  line.status === "ok" ? { status: "ok", widget: line.widget } : { status: line.status };

/**
 * Asks Core for `widgets`, each in its size, and reports every widget exactly once: with its own answer, or as
 * `error` when the request fails or the stream breaks off before it answered. Nothing is reported once `signal` aborts.
 */
export const loadDashboardWidgets = async (options: {
  widgets: readonly DashboardBoardEntry[];
  signal: AbortSignal;
  locale: string;
  onTile: (id: string, state: DashboardTileState) => void;
}): Promise<void> => {
  if (options.widgets.length === 0) return;
  const owed = new Set(options.widgets.map((widget) => widget.id));
  try {
    await streamWidgets({
      requests: options.widgets.map((entry) => {
        const settings = widgetRequestSettings(entry.settings);
        return { id: entry.id, key: entry.key, size: entry.size, ...(settings ? { settings } : {}) };
      }),
      signal: options.signal,
      locale: options.locale,
      onLine: (line) => {
        if (line.type !== "widget" || line.id === undefined || !owed.delete(line.id) || options.signal.aborted) return;
        options.onTile(line.id, tileFromLine(line));
      },
    });
  } catch {
    // The widgets still owed fail on their own below, each with its own retry.
  }
  if (options.signal.aborted) return;
  for (const id of owed) options.onTile(id, { status: "error" });
};
