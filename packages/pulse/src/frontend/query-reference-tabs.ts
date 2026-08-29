export type ReferenceTab = "overview" | "query" | "dashboard" | "inventory";

type ReferenceTabItem = {
  value: ReferenceTab;
  label: string;
  icon: string;
};

export const defaultReferenceTab = (includeDashboardDsl: boolean): ReferenceTab => (includeDashboardDsl ? "dashboard" : "overview");

export const referenceTabs = (
  includeDashboardDsl: boolean,
  labels = { overview: "Overview", query: "Query DSL", dashboard: "Dashboard DSL", inventory: "Inventory" },
): ReferenceTabItem[] => [
  { value: "overview", label: labels.overview, icon: "ti ti-home" },
  { value: "query", label: labels.query, icon: "ti ti-code" },
  ...(includeDashboardDsl ? [{ value: "dashboard" as const, label: labels.dashboard, icon: "ti ti-layout-dashboard" }] : []),
  { value: "inventory", label: labels.inventory, icon: "ti ti-database-search" },
];

const availableReferenceTabs = (includeDashboardDsl: boolean): Set<string> =>
  new Set(referenceTabs(includeDashboardDsl).map((tab) => tab.value));

export const isAvailableReferenceTab = (value: string | null | undefined, includeDashboardDsl: boolean): value is ReferenceTab =>
  Boolean(value && availableReferenceTabs(includeDashboardDsl).has(value));

export const readReferenceTab = (value: string | null | undefined, includeDashboardDsl: boolean): ReferenceTab =>
  isAvailableReferenceTab(value, includeDashboardDsl) ? value : defaultReferenceTab(includeDashboardDsl);
