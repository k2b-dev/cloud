import { createHash } from "node:crypto";
import { err, fail, ok } from "@k2b/cloud/server";
import { sql } from "bun";
import {
  DASHBOARD_REFRESH_MS,
  DashboardDefinitionSchema,
  type DashboardPanel,
  type DashboardRange,
  DashboardRangeSchema,
  dashboardParameters,
  dashboardWindow,
} from "../dashboard-contracts";
import { projectDashboardPanel } from "../dashboard-result";
import { requireBaseAccess } from "./access-control";
import { type DashboardSnapshot, dashboardCache } from "./dashboard-cache";
import { dashboardRuns } from "./dashboard-runs";
import { authorizeDashboardBase, type DashboardIdentity, type DashboardRow, dashboardTokenHash, findDashboard } from "./dashboards";
import { runBaseSql, runPublishedDashboardSql, sqlFailure } from "./sql-service";

type Target = { baseId: string; dashboardId: string; identity: DashboardIdentity } | { token: string };
type Input = Target & { panelId: string; range: DashboardRange; signal?: AbortSignal };
export type DashboardPanelResult = {
  panelId: string;
  status: "ready" | "refreshing" | "error" | "waiting";
  error: string | null;
  nextRefreshAt: string;
  lastGood: DashboardSnapshot | null;
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const load = async (target: Target) => {
  let dashboard: DashboardRow | undefined;
  let tokenHash: string | undefined;
  if ("token" in target) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(target.token)) return null;
    tokenHash = dashboardTokenHash(target.token);
    const [row] = await sql<
      DashboardRow[]
    >`SELECT d.*,b.short_id AS base_short_id FROM pulse.dashboards d JOIN pulse.bases b ON b.id=d.base_id
      WHERE d.public_token_hash=${tokenHash} AND b.deletion_started_at IS NULL`;
    dashboard = row;
  } else {
    const access = await authorizeDashboardBase({ ...target.identity, baseId: target.baseId }, "read");
    if (!access.ok) return null;
    dashboard = await findDashboard(access.data.baseId, target.dashboardId);
    if (!(await requireBaseAccess(access.data.baseId, access.data.scope, "read")).ok) return null;
  }
  if (!dashboard) return null;
  const [base] = await sql<{ reset_generation: string; timezone: string; state: string }[]>`
    SELECT s.reset_generation::text AS reset_generation,s.state,b.timezone FROM pulse.base_stores s JOIN pulse.bases b ON b.id=s.base_id
    WHERE s.base_id=${dashboard.base_id}::uuid AND b.deletion_started_at IS NULL`;
  if (!base) return null;
  return { dashboard, base, tokenHash };
};
/** A public document contains presentation and the explicitly reviewed projection,
 * never SQL, parameters, actor identity or an undisclosed output column. */
export const readPublicDashboard = async (token: string) => {
  const loaded = await load({ token });
  if (!loaded) return fail(err.notFound("Dashboard publication"));
  const definition = DashboardDefinitionSchema.parse(loaded.dashboard.definition);
  return ok({
    id: loaded.dashboard.short_id,
    name: loaded.dashboard.name,
    revision: loaded.dashboard.revision,
    panels: definition.panels.map(({ sql: _sql, params: _params, ...presentation }) => presentation),
  });
};
export const createDashboardPanels = (
  dependencies: {
    cache?: typeof dashboardCache;
    runs?: typeof dashboardRuns;
    privateRun?: typeof runBaseSql;
    publicRun?: typeof runPublishedDashboardSql;
    now?: () => Date;
  } = {},
) => {
  const cache = dependencies.cache ?? dashboardCache,
    runs = dependencies.runs ?? dashboardRuns;
  return async (input: Input) => {
    const range = DashboardRangeSchema.safeParse(input.range);
    if (!range.success) return fail(err.badInput("Choose a valid dashboard range"));
    const loaded = await load(input);
    if (!loaded) return fail(err.notFound("Dashboard"));
    const { dashboard, base, tokenHash } = loaded;
    const panel = DashboardDefinitionSchema.parse(dashboard.definition).panels.find((panel) => panel.id === input.panelId);
    if (!panel) return fail(err.notFound("Dashboard panel"));
    const canonicalRange = range.data.from ? dashboardWindow(range.data, dependencies.now?.() ?? new Date()) : { range: range.data.range };
    const variant = hash([panel.id, dashboard.revision, base.reset_generation, base.timezone, tokenHash ?? "private", canonicalRange]);
    const key = `${dashboard.id}:${variant}`;
    let snapshot = await cache.read(key).catch(() => null);
    let error: string | null = base.state === "active" ? null : "STORE_UNAVAILABLE";
    let owned: Awaited<ReturnType<typeof runs.claim>> = null;
    if (!error && !input.signal?.aborted) {
      try {
        owned = await runs.claim(dashboard.id, variant);
      } catch {
        error = "STORE_UNAVAILABLE";
      }
    }
    if (owned) {
      const deadline = AbortSignal.timeout(45_000);
      const signal = AbortSignal.any([deadline, ...(input.signal ? [input.signal] : [])]);
      let next: DashboardSnapshot | null = null;
      try {
        const window = dashboardWindow(range.data, new Date(owned.slot));
        const result = tokenHash
          ? await (dependencies.publicRun ?? runPublishedDashboardSql)({
              dashboardId: dashboard.id,
              panelId: panel.id,
              revision: dashboard.revision,
              resetGeneration: base.reset_generation,
              tokenHash,
              window,
              signal,
            })
          : "identity" in input
            ? await (dependencies.privateRun ?? runBaseSql)({
                ...input.identity,
                baseId: dashboard.base_id,
                sql: panel.sql,
                params: dashboardParameters(panel, window),
                via: "dashboard",
                signal,
              })
            : sqlFailure(new Error("Missing dashboard identity"));
        if (!result.ok) error = result.error.code;
        else {
          let data: ReturnType<typeof projectDashboardPanel>;
          try {
            data = projectDashboardPanel(panel, result.data);
          } catch {
            throw new Error("PANEL_RESULT_INVALID");
          }
          next = { at: (dependencies.now?.() ?? new Date()).toISOString(), from: window.from, to: window.to, slot: owned.slot, data };
        }
      } catch (failure) {
        error = failure instanceof Error && failure.message === "PANEL_RESULT_INVALID" ? "PANEL_RESULT_INVALID" : "STORE_UNAVAILABLE";
      }
      const current = await load(input);
      if (
        !current ||
        current.dashboard.revision !== dashboard.revision ||
        current.base.reset_generation !== base.reset_generation ||
        current.base.timezone !== base.timezone ||
        current.base.state !== "active"
      ) {
        await runs.finish(dashboard.id, variant, owned.leaseId, "CANCELLED").catch(() => false);
        return fail(err.notFound("Dashboard changed. Reload it to continue."));
      }
      const committed = await runs.finish(dashboard.id, variant, owned.leaseId, error).catch(() => false);
      if (!committed) error = "STORE_UNAVAILABLE";
      else if (next && !error) {
        snapshot = next;
        const stored = await cache.put(key, next).catch(() => false);
        if (!stored) snapshot = (await cache.read(key).catch(() => null)) ?? next;
      }
    }
    // A cache hit is subject to the same permission/publication checks as execution.
    const current = await load(input);
    if (
      !current ||
      current.dashboard.revision !== dashboard.revision ||
      current.base.reset_generation !== base.reset_generation ||
      current.base.timezone !== base.timezone
    )
      return fail(err.notFound("Dashboard changed. Reload it to continue."));
    const state = await runs.read(dashboard.id, variant);
    if (!state?.lease_id && state?.slot_start.toISOString() !== snapshot?.slot)
      snapshot = (await cache.read(key).catch(() => null)) ?? snapshot;
    const now = (dependencies.now?.() ?? new Date()).getTime();
    const refreshing = !!state?.lease_id && !!state.lease_until && state.lease_until.getTime() > now;
    error ??= state?.error_code ?? (state?.lease_id && !refreshing ? "TIME_LIMIT" : null);
    if (current.base.state !== "active") error = "STORE_UNAVAILABLE";
    const nextRefreshAt = new Date(
      Math.max(
        state?.slot_start ? state.slot_start.getTime() + DASHBOARD_REFRESH_MS : now + DASHBOARD_REFRESH_MS,
        state?.retry_at?.getTime() ?? 0,
        state?.lease_until?.getTime() ?? 0,
      ),
    ).toISOString();
    const result: DashboardPanelResult = {
      panelId: panel.id,
      status: error
        ? "error"
        : refreshing
          ? "refreshing"
          : snapshot && state?.slot_start.toISOString() === snapshot.slot
            ? "ready"
            : "waiting",
      error,
      nextRefreshAt,
      lastGood: snapshot,
    };
    return ok(result);
  };
};
export const readDashboardPanel = createDashboardPanels();
export type PublicDashboardPanel = Omit<DashboardPanel, "sql" | "params">;
