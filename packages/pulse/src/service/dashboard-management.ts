import { err, fail, ok, type Result } from "@k2b/cloud/server";
import { sql } from "bun";
import type { PulseDashboard } from "../contracts";
import { withShortId } from "../lib/short-id";
import { type AccessScope, requireBaseAccess, requireBaseActive, userIdForScope } from "./access-control";
import { compileDashboardConfigForSave, normalizeDashboardConfig, validateDashboardSources } from "./dashboard-config";
import { resolvePublicDashboardToken } from "./public-dashboard-tokens";
import { iso } from "./telemetry-values";

type DashboardRow = {
  id: string;
  base_id: string;
  name: string;
  config: unknown;
  public_enabled: boolean;
  public_token_encrypted: string | null;
  public_token_hash: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const mapDashboard = (row: DashboardRow): PulseDashboard => ({
  id: row.id,
  baseId: row.base_id,
  name: row.name,
  config: normalizeDashboardConfig(row.config),
  publicEnabled: row.public_enabled,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

export const listDashboards = async (baseId: string, user: AccessScope): Promise<Result<PulseDashboard[]>> => {
  const access = await requireBaseAccess(baseId, user, "read");
  if (!access.ok) return fail(access.error);
  const rows = await sql<DashboardRow[]>`
    SELECT *
    FROM pulse.dashboards
    WHERE base_id = ${baseId}::uuid
    ORDER BY updated_at DESC, name ASC
  `;
  return ok(rows.map(mapDashboard));
};

export const createDashboard = async (params: {
  baseId: string;
  user: AccessScope;
  name: string;
  config?: unknown;
}): Promise<Result<PulseDashboard>> => {
  const access = await requireBaseAccess(params.baseId, params.user, "write");
  if (!access.ok) return fail(access.error);
  const active = await requireBaseActive(params.baseId);
  if (!active.ok) return fail(active.error);
  const name = params.name.trim();
  if (!name) return fail(err.badInput("Dashboard name is required"));
  const configResult = compileDashboardConfigForSave(params.baseId, params.config ?? {});
  if (!configResult.ok) return fail(configResult.error);
  const validated = await validateDashboardSources(params.baseId, configResult.data);
  if (!validated.ok) return fail(validated.error);
  const config = validated.data;
  const row = await withShortId("dashboard", async (shortId) => {
    const [created] = await sql<DashboardRow[]>`
      INSERT INTO pulse.dashboards (short_id, base_id, name, config, created_by)
      VALUES (${shortId}, ${params.baseId}::uuid, ${name}, ${JSON.stringify(config)}::jsonb, ${userIdForScope(params.user)}::uuid)
      RETURNING *
    `;
    return created;
  });
  if (!row) return fail(err.internal("Failed to create Pulse dashboard"));
  return ok(mapDashboard(row));
};

export const updateDashboard = async (params: {
  dashboardId: string;
  user: AccessScope;
  name?: string;
  config?: unknown;
}): Promise<Result<PulseDashboard>> => {
  const [existing] = await sql<{ base_id: string; name: string; config: unknown }[]>`
    SELECT base_id, name, config
    FROM pulse.dashboards
    WHERE id = ${params.dashboardId}::uuid
  `;
  if (!existing) return fail(err.notFound("Pulse dashboard"));
  const access = await requireBaseAccess(existing.base_id, params.user, "write");
  if (!access.ok) return fail(access.error);
  const active = await requireBaseActive(existing.base_id);
  if (!active.ok) return fail(active.error);
  const name = params.name?.trim() || existing.name;
  const configResult = compileDashboardConfigForSave(existing.base_id, params.config ?? existing.config);
  if (!configResult.ok) return fail(configResult.error);
  const validated = await validateDashboardSources(existing.base_id, configResult.data);
  if (!validated.ok) return fail(validated.error);
  const config = validated.data;
  const [row] = await sql<DashboardRow[]>`
    UPDATE pulse.dashboards
    SET name = ${name}, config = ${JSON.stringify(config)}::jsonb, updated_at = now()
    WHERE id = ${params.dashboardId}::uuid
    RETURNING *
  `;
  if (!row) return fail(err.internal("Failed to update Pulse dashboard"));
  return ok(mapDashboard(row));
};

export const deleteDashboard = async (params: { dashboardId: string; user: AccessScope }): Promise<Result<void>> => {
  const [existing] = await sql<{ base_id: string }[]>`
    SELECT base_id
    FROM pulse.dashboards
    WHERE id = ${params.dashboardId}::uuid
  `;
  if (!existing) return fail(err.notFound("Pulse dashboard"));
  const access = await requireBaseAccess(existing.base_id, params.user, "write");
  if (!access.ok) return fail(access.error);
  const active = await requireBaseActive(existing.base_id);
  if (!active.ok) return fail(active.error);
  const deleted = await sql`DELETE FROM pulse.dashboards WHERE id = ${params.dashboardId}::uuid`;
  if ((deleted.count ?? 0) === 0) return fail(err.notFound("Pulse dashboard"));
  return ok();
};

export const enablePublicDashboard = async (params: {
  dashboardId: string;
  user: AccessScope;
}): Promise<Result<{ dashboard: PulseDashboard; token: string }>> => {
  const [existing] = await sql<{ base_id: string; public_enabled: boolean; public_token_encrypted: string | null }[]>`
    SELECT base_id, public_enabled, public_token_encrypted
    FROM pulse.dashboards
    WHERE id = ${params.dashboardId}::uuid
  `;
  if (!existing) return fail(err.notFound("Pulse dashboard"));
  const access = await requireBaseAccess(existing.base_id, params.user, "write");
  if (!access.ok) return fail(access.error);
  const active = await requireBaseActive(existing.base_id);
  if (!active.ok) return fail(active.error);

  const publicToken = await resolvePublicDashboardToken({
    publicEnabled: existing.public_enabled,
    encryptedToken: existing.public_token_encrypted,
  });
  const [row] = await sql<DashboardRow[]>`
    UPDATE pulse.dashboards
    SET public_enabled = TRUE,
        public_token_encrypted = ${publicToken.encryptedToken},
        public_token_hash = ${publicToken.tokenHash},
        updated_at = now()
    WHERE id = ${params.dashboardId}::uuid
    RETURNING *
  `;
  if (!row) return fail(err.internal("Failed to publish Pulse dashboard"));
  return ok({ dashboard: mapDashboard(row), token: publicToken.token });
};

export const disablePublicDashboard = async (params: { dashboardId: string; user: AccessScope }): Promise<Result<PulseDashboard>> => {
  const [existing] = await sql<{ base_id: string }[]>`
    SELECT base_id
    FROM pulse.dashboards
    WHERE id = ${params.dashboardId}::uuid
  `;
  if (!existing) return fail(err.notFound("Pulse dashboard"));
  const access = await requireBaseAccess(existing.base_id, params.user, "write");
  if (!access.ok) return fail(access.error);
  const active = await requireBaseActive(existing.base_id);
  if (!active.ok) return fail(active.error);

  const [row] = await sql<DashboardRow[]>`
    UPDATE pulse.dashboards
    SET public_enabled = FALSE, public_token_encrypted = NULL, public_token_hash = NULL, updated_at = now()
    WHERE id = ${params.dashboardId}::uuid
    RETURNING *
  `;
  if (!row) return fail(err.internal("Failed to unpublish Pulse dashboard"));
  return ok(mapDashboard(row));
};
