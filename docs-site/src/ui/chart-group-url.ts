import type { ChartExplorerRequest } from "@k2b/ui";
import { explorerSteps, explorerSeries } from "./chart-explorer-data";
export function chartRequestFromSearch(search = ""): ChartExplorerRequest {
  const params = new URLSearchParams(search);
  const step = params.get("explorerStep");
  const reference = params.get("explorerReference");
  const keys = params.get("explorerSeries");
  return {
    step: explorerSteps.some((item) => item.key === step) ? step! : "08",
    referenceStep: explorerSteps.some((item) => item.key === reference) ? reference! : undefined,
    visibleKeys:
      keys === null
        ? explorerSeries.map((item) => item.key)
        : [...new Set(keys.split(","))].filter((key) => explorerSeries.some((item) => item.key === key)),
  };
}
export function chartSearchParams(request: ChartExplorerRequest, existing = new URLSearchParams()) {
  const params = new URLSearchParams(existing);
  if (request.step) params.set("explorerStep", request.step);
  else params.delete("explorerStep");
  if (request.referenceStep) params.set("explorerReference", request.referenceStep);
  else params.delete("explorerReference");
  if (request.visibleKeys) params.set("explorerSeries", request.visibleKeys.join(","));
  else params.delete("explorerSeries");
  return params;
}
