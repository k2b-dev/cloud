import type { AppRegistryDetail } from "@k2b/cloud";
import type { AppRegistryEntry } from "@k2b/cloud/contracts";
import { err, fail, ok, type Result } from "@k2b/cloud/server";
import { sql } from "bun";

type DbRegisteredAppRow = {
  id: string;
  name: string;
  icon: string;
  description: string;
  appearance: unknown;
  runtime: unknown;
  base_url: string;
  routes: unknown;
  nav: unknown;
  capabilities: unknown;
  legal_links: unknown;
  widgets: unknown;
  openapi: string | null;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
  updated_at: Date | string;
  removed_at: Date | string | null;
  last_offline_logged_at: Date | string | null;
};

export type PersistentRegisteredApp = AppRegistryEntry & {
  firstSeenAt: number;
  lastSeenAt: number;
  updatedAt: number;
  removedAt: number | null;
  lastOfflineLoggedAt: number | null;
};

export type RegisteredAppStatus = PersistentRegisteredApp & {
  live: AppRegistryDetail | null;
  isOnline: boolean;
  offlineForMs: number;
};

const asMs = (value: Date | string | null): number | null => {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

const jsonArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const jsonObject = <T>(value: unknown): T | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as T) : undefined;

const mapRow = (row: DbRegisteredAppRow): PersistentRegisteredApp => ({
  id: row.id,
  name: row.name,
  icon: row.icon,
  description: row.description,
  appearance: jsonObject<AppRegistryEntry["appearance"]>(row.appearance),
  runtime: jsonObject<AppRegistryEntry["runtime"]>(row.runtime),
  baseUrl: row.base_url,
  routes: jsonArray<string>(row.routes),
  nav: jsonObject<AppRegistryEntry["nav"]>(row.nav),
  capabilities: jsonObject<AppRegistryEntry["capabilities"]>(row.capabilities),
  legalLinks: jsonArray<NonNullable<AppRegistryEntry["legalLinks"]>[number]>(row.legal_links),
  widgets: jsonArray<NonNullable<AppRegistryEntry["widgets"]>[number]>(row.widgets),
  openapi: row.openapi ?? undefined,
  firstSeenAt: asMs(row.first_seen_at) ?? Date.now(),
  lastSeenAt: asMs(row.last_seen_at) ?? Date.now(),
  updatedAt: asMs(row.updated_at) ?? Date.now(),
  removedAt: asMs(row.removed_at),
  lastOfflineLoggedAt: asMs(row.last_offline_logged_at),
});

export const upsertRegisteredApps = async (apps: readonly AppRegistryEntry[]): Promise<void> => {
  for (const app of apps) {
    await sql`
      INSERT INTO gateway.registered_apps (
        id, name, icon, description, appearance, runtime, base_url, routes, nav, capabilities, legal_links,
        widgets, openapi, first_seen_at, last_seen_at, updated_at, removed_at
      )
      VALUES (
        ${app.id},
        ${app.name},
        ${app.icon},
        ${app.description},
        ${app.appearance ? JSON.stringify(app.appearance) : null}::jsonb,
        ${app.runtime ? JSON.stringify(app.runtime) : null}::jsonb,
        ${app.baseUrl},
        ${JSON.stringify(app.routes)}::jsonb,
        ${app.nav ? JSON.stringify(app.nav) : null}::jsonb,
        ${app.capabilities ? JSON.stringify(app.capabilities) : null}::jsonb,
        ${app.legalLinks ? JSON.stringify(app.legalLinks) : null}::jsonb,
        ${app.widgets ? JSON.stringify(app.widgets) : null}::jsonb,
        ${app.openapi ?? null},
        now(),
        now(),
        now(),
        NULL
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        icon = EXCLUDED.icon,
        description = EXCLUDED.description,
        appearance = EXCLUDED.appearance,
        runtime = EXCLUDED.runtime,
        base_url = EXCLUDED.base_url,
        routes = EXCLUDED.routes,
        nav = EXCLUDED.nav,
        capabilities = EXCLUDED.capabilities,
        legal_links = EXCLUDED.legal_links,
        widgets = EXCLUDED.widgets,
        openapi = EXCLUDED.openapi,
        last_seen_at = now(),
        updated_at = now(),
        removed_at = NULL,
        last_offline_logged_at = NULL
    `;
  }
};

export const listRegisteredApps = async (): Promise<PersistentRegisteredApp[]> => {
  const rows = await sql<DbRegisteredAppRow[]>`
    SELECT *
    FROM gateway.registered_apps
    WHERE removed_at IS NULL
    ORDER BY name ASC, id ASC
  `;
  return rows.map(mapRow);
};

export const listRegisteredAppStatus = async (liveApps: readonly AppRegistryDetail[]): Promise<RegisteredAppStatus[]> => {
  const liveById = new Map(liveApps.map((app) => [app.id, app]));
  const now = Date.now();
  return (await listRegisteredApps()).map((app) => {
    const live = liveById.get(app.id) ?? null;
    const lastSeenAt = live?.updatedAt ?? app.lastSeenAt;
    return {
      ...app,
      live,
      isOnline: Boolean(live),
      offlineForMs: live ? 0 : Math.max(0, now - lastSeenAt),
    };
  });
};

export const removeOfflineRegisteredApp = async (appId: string, liveApps: readonly AppRegistryEntry[]): Promise<Result<{ id: string }>> => {
  if (liveApps.some((app) => app.id === appId)) return fail(err.badInput("Only offline apps can be removed."));
  const rows = await sql<{ id: string }[]>`
    UPDATE gateway.registered_apps
    SET removed_at = now()
    WHERE id = ${appId}
      AND removed_at IS NULL
    RETURNING id
  `;
  if (!rows[0]) return fail(err.notFound("Registered app"));
  return ok({ id: rows[0].id });
};

export const markOfflineLogged = async (appId: string): Promise<void> => {
  await sql`
    UPDATE gateway.registered_apps
    SET last_offline_logged_at = now()
    WHERE id = ${appId}
  `;
};
