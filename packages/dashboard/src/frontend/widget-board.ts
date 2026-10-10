import { type DashboardWidgetSize, streamWidgets, type WidgetResponse, type WidgetStreamLine } from "@k2b/cloud/browser/widgets";

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
  widgets: readonly { key: string; size: DashboardWidgetSize }[];
  signal: AbortSignal;
  locale: string;
  onTile: (key: string, state: DashboardTileState) => void;
}): Promise<void> => {
  if (options.widgets.length === 0) return;
  const owed = new Set(options.widgets.map((widget) => widget.key));
  try {
    await streamWidgets({
      keys: [...owed],
      sizes: Object.fromEntries(options.widgets.map((widget) => [widget.key, widget.size])),
      signal: options.signal,
      locale: options.locale,
      onLine: (line) => {
        if (line.type !== "widget" || !owed.delete(line.key) || options.signal.aborted) return;
        options.onTile(line.key, tileFromLine(line));
      },
    });
  } catch {
    // The widgets still owed fail on their own below, each with its own retry.
  }
  if (options.signal.aborted) return;
  for (const key of owed) options.onTile(key, { status: "error" });
};
