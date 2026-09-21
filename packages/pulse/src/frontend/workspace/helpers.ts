export * from "../http";
export * from "./chart-data";
export * from "./dashboard-actions";
export * from "./dashboard-dsl-helpers";
export * from "./dashboard-layout";
export * from "./dashboard-query-text";
export * from "./date-format";
export * from "./metric-format";
export * from "./query-actions";
export * from "./query-history";
export * from "./saved-query-actions";
export * from "./signal-helpers";
export * from "./source-actions";
export * from "./source-helpers";
export * from "./workspace-constants";
export * from "./workspace-options";

export const plural = (count: number, singular: string, pluralLabel = `${singular}s`) => `${count} ${count === 1 ? singular : pluralLabel}`;

export const openQueryReferenceWindow = (baseId: string | null | undefined, options: { dashboardDsl?: boolean } = {}) => {
  if (!baseId || typeof window === "undefined") return;
  const params = options.dashboardDsl ? "?dashboardDsl=1" : "";
  window.open(
    `/app/pulse/${encodeURIComponent(baseId)}/query-reference${params}`,
    "pulse-query-reference",
    "popup,width=1180,height=840,resizable=yes,scrollbars=yes",
  );
};
