import type { ActivityQueryState, ResourceQueryState } from "./route-types";

type DashboardControlQueryState = Record<string, string>;

const DASHBOARD_CONTROL_PREFIX = "c_";

const dashboardControlVariable = (param: string): string | null =>
  param.startsWith(DASHBOARD_CONTROL_PREFIX) ? param.slice(DASHBOARD_CONTROL_PREFIX.length) : null;

export const readDashboardControlQueryState = (search: string): DashboardControlQueryState => {
  const params = new URLSearchParams(search);
  const values: DashboardControlQueryState = {};
  for (const [param, value] of params.entries()) {
    const variable = dashboardControlVariable(param);
    if (variable) values[variable] = value;
  }
  return values;
};

export const readActivityQueryState = (search: string): ActivityQueryState => {
  const params = new URLSearchParams(search);
  const type = params.get("type") ?? "";
  return {
    q: params.get("q")?.trim() ?? "",
    type: type === "gauge" || type === "counter" ? type : "",
  };
};

export const readResourceQueryState = (search: string): ResourceQueryState => {
  const params = new URLSearchParams(search);
  return {
    q: params.get("q")?.trim() ?? "",
    sourceId: params.get("source")?.trim() ?? "",
    type: params.get("type")?.trim() ?? "",
  };
};
