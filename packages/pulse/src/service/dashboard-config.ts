import { err, fail, ok, type Result } from "@k2b/cloud/server";
import { z } from "zod";
import type { PulseDashboardConfig } from "../contracts";
import { compileDashboardDsl } from "../dashboard-dsl";
import { compilePulseQueryText } from "../query-dsl";
import { resolveBasePublicIds } from "./public-resources";

export { dashboardEventsWidgets, dashboardMapWidgets, dashboardMetricWidgets, dashboardStatesWidgets } from "./dashboard-widget-selectors";

const DashboardSourceSchema = z.strictObject({
  dsl: z.string().trim().min(1).max(40_000),
  refreshIntervalSeconds: z
    .union([z.literal(1), z.literal(5), z.literal(10), z.literal(60)])
    .nullable()
    .optional(),
});

export const compileDashboardConfigForSave = (baseId: string, input: unknown): Result<PulseDashboardConfig> => {
  const source = DashboardSourceSchema.safeParse(input);
  if (!source.success) return fail(err.badInput(source.error.issues[0]?.message ?? "Invalid dashboard source"));
  const compiled = compileDashboardDsl(source.data.dsl, (text) => {
    const result = compilePulseQueryText(baseId, text);
    return result.ok ? { ok: true, data: result.data } : { ok: false, message: result.error.message };
  });
  if (!compiled.ok) return fail(err.badInput(compiled.diagnostics[0]?.message ?? "Invalid dashboard DSL"));
  return ok({ ...compiled.data, refreshIntervalSeconds: source.data.refreshIntervalSeconds });
};

export const readDashboardConfig = (baseId: string, input: unknown): PulseDashboardConfig => {
  const result = compileDashboardConfigForSave(baseId, input);
  if (!result.ok) throw err.internal(`Stored dashboard is invalid: ${result.error.message}`);
  return result.data;
};

export const dashboardSource = (config: PulseDashboardConfig) => ({
  dsl: config.dsl,
  refreshIntervalSeconds: config.refreshIntervalSeconds,
});

export const validateDashboardSources = async (baseId: string, config: PulseDashboardConfig): Promise<Result<PulseDashboardConfig>> => {
  const sourceIds: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      if (key === "sourceId" && typeof nested === "string") sourceIds.push(nested);
      else visit(nested);
    }
  };
  visit(config.layout);
  const sources = await resolveBasePublicIds("sources", baseId, sourceIds);
  return sources ? ok(config) : fail(err.badInput("Dashboard references an unknown Source ID"));
};
