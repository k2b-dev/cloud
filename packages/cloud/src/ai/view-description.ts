import type { CloudAiChartView, CloudAiStatsView, CloudAiView, CloudStatsDescription, CloudViewDescription } from "./view-block";

/** Saved view envelopes remain compatible; hosts draw their contents through the portable node. */
export function cloudAiViewDescription<V extends CloudAiView>(
  view: V,
): V extends CloudAiChartView
  ? import("@k2b/ui/charts").ChartInput
  : V extends CloudAiStatsView
    ? CloudStatsDescription
    : Omit<V, "view"> & { block: V["view"] };
export function cloudAiViewDescription(view: CloudAiView): CloudViewDescription {
  if (view.view === "chart") {
    const { view: _view, ...chart } = view;
    return chart;
  }
  if (view.view === "stats") {
    const { view: block, items, ...data } = view;
    return {
      block,
      ...data,
      items: items.map(({ delta, better, ...item }) => ({
        ...item,
        ...(delta === undefined
          ? {}
          : { delta: typeof delta === "number" ? { value: delta, unit: "absolute", better, format: item.format } : delta }),
      })),
    };
  }
  if (view.view === "table") {
    const { view: block, ...data } = view;
    return { block, ...data };
  }
  if (view.view === "details") {
    const { view: block, ...data } = view;
    return { block, ...data };
  }
  if (view.view === "group") {
    const { view: block, ...data } = view;
    return { block, ...data };
  }
  const { view: block, ...data } = view;
  return { block, ...data };
}
