import type { DashboardWidgetSize, WidgetStreamLine } from "../contracts/widgets";
import { LOCALE_HEADER } from "../shared/locale";
import { NDJSON_CONTENT_TYPE, readNdjsonLines } from "./ndjson";

export type { DashboardWidgetSize, WidgetResponse, WidgetStreamLine, WidgetStreamStatus } from "../contracts/widgets";

/**
 * Asks Core for dashboard widgets and hands over each one as soon as it answers: `start` names the widgets, one
 * `widget` line follows per widget in the order they finish, then `done`. `keys` (`<appId>/<widgetId>`) limits the
 * request, for example to retry one widget; without it Core asks every declared widget. `sizes` names the size to ask
 * a widget for; a widget without one, or with a size it does not offer, answers in its default size. Aborting `signal`
 * stops every widget Core still waits for. Rejects when the request fails or the stream breaks off.
 */
export const streamWidgets = async (options: {
  keys?: readonly string[];
  sizes?: Readonly<Record<string, DashboardWidgetSize>>;
  signal: AbortSignal;
  locale: string;
  onLine: (line: WidgetStreamLine) => void;
}): Promise<void> => {
  const query = new URLSearchParams();
  for (const key of options.keys ?? []) query.append("widget", options.sizes?.[key] ? `${key}@${options.sizes[key]}` : key);
  const search = query.toString();
  const response = await fetch(`/api/widgets/v1${search ? `?${search}` : ""}`, {
    signal: options.signal,
    headers: { accept: NDJSON_CONTENT_TYPE, [LOCALE_HEADER]: options.locale },
  });
  if (!response.ok) throw new Error(`Widgets failed with ${response.status}`);
  await readNdjsonLines(response, options.onLine, "Widgets");
};
