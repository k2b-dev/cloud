import { type AppRegistryDetail, readAppRegistrySnapshot, sql } from "@k2b/cloud";
import type { AppRegistryEntry } from "@k2b/cloud/contracts";
import type { AppStatusSummaries, ProviderRef } from "./app-status";

export type KnownApp = {
  id: string;
  name: string;
  description: string;
  icon: string;
  accent: string | null;
  release: string | null;
  routes: string[];
  navHref: string | null;
  adminHref: string | null;
  firstSeenAt: string;
  lastSeenAt: string | null;
  hidden: boolean;
};
type KnownAppRow = {
  id: string;
  name: string;
  description: string;
  icon: string;
  accent: string | null;
  release: string | null;
  routes: string[];
  nav_href: string | null;
  admin_href: string | null;
  status_providers: Record<string, ProviderRef>;
  first_seen_at: Date;
  last_seen_at: Date | null;
  hidden_at: Date | null;
};

/** Batches share one observation time. Older replicas cannot replace newer metadata or unhide an old lease. */
export const rememberApps = async (apps: readonly (AppRegistryEntry | AppRegistryDetail)[]): Promise<void> => {
  const observedAt = Date.now();
  for (let offset = 0; offset < apps.length; offset += 200) {
    const rows = apps.slice(offset, offset + 200).map((app) => ({
      id: app.id,
      name: app.name,
      description: app.description,
      icon: app.icon,
      accent: app.appearance?.accent ?? null,
      release: app.runtime?.version ?? app.runtime?.release ?? null,
      routes: app.routes,
      nav_href: app.nav?.href || null,
      admin_href: app.nav?.adminHref ?? null,
      last_seen_at: new Date("updatedAt" in app ? app.updatedAt : observedAt).toISOString(),
    }));
    await sql`INSERT INTO core.known_apps (id, name, description, icon, accent, release, routes, nav_href, admin_href, last_seen_at)
      SELECT id, name, description, icon, accent, release, routes, nav_href, admin_href, last_seen_at
      FROM jsonb_to_recordset((${JSON.stringify(rows)}::jsonb #>> '{}')::jsonb) AS entry(
        id text, name text, description text, icon text, accent text, release text, routes jsonb, nav_href text, admin_href text, last_seen_at timestamptz)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name, description = EXCLUDED.description, icon = EXCLUDED.icon, accent = EXCLUDED.accent,
        release = EXCLUDED.release, routes = EXCLUDED.routes, nav_href = EXCLUDED.nav_href, admin_href = EXCLUDED.admin_href,
        last_seen_at = EXCLUDED.last_seen_at,
        hidden_at = CASE WHEN EXCLUDED.last_seen_at > core.known_apps.hidden_at THEN NULL ELSE core.known_apps.hidden_at END
      WHERE core.known_apps.last_seen_at IS NULL OR EXCLUDED.last_seen_at >= core.known_apps.last_seen_at`;
  }
};

export const listKnownApps = async (): Promise<KnownApp[]> => {
  const rows = await sql<KnownAppRow[]>`SELECT * FROM core.known_apps ORDER BY name, id`;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    accent: row.accent,
    release: row.release,
    routes: row.routes,
    navHref: row.nav_href,
    adminHref: row.admin_href,
    firstSeenAt: row.first_seen_at.toISOString(),
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    hidden: row.hidden_at !== null,
  }));
};

/** Retain reporting provenance so removing an offline provider cannot silently skip its forget Action. */
export const rememberAppStatusReports = async (summary: AppStatusSummaries): Promise<void> => {
  const reports = new Map<string, Record<string, ProviderRef>>();
  for (const [appId, rows] of summary.byApp) reports.set(appId, Object.fromEntries(rows.map((row) => [row.provider.appId, row.provider])));
  for (const row of summary.otherApps) {
    const providers = reports.get(row.appId) ?? {};
    providers[row.provider.appId] = row.provider;
    reports.set(row.appId, providers);
  }
  const entries = [...reports].map(([id, providers]) => ({ id, providers }));
  for (let offset = 0; offset < entries.length; offset += 200) {
    await sql`INSERT INTO core.known_apps (id, name, status_providers)
      SELECT id, id, providers FROM jsonb_to_recordset((${JSON.stringify(entries.slice(offset, offset + 200))}::jsonb #>> '{}')::jsonb) AS entry(id text, providers jsonb)
      ON CONFLICT (id) DO UPDATE SET status_providers = core.known_apps.status_providers || EXCLUDED.status_providers`;
  }
};

export const listingStatusProviders = async (appId: string): Promise<ProviderRef[]> => {
  const [row] = await sql<Pick<KnownAppRow, "status_providers">[]>`SELECT status_providers FROM core.known_apps WHERE id = ${appId}`;
  return Object.values(row?.status_providers ?? {});
};

export const keepAppListingVisible = async (appId: string): Promise<void> => {
  await sql`INSERT INTO core.known_apps (id, name) VALUES (${appId}, ${appId}) ON CONFLICT (id) DO NOTHING`;
};

export const hideKnownApp = async (appId: string): Promise<void> => {
  await sql`INSERT INTO core.known_apps (id, name, hidden_at) VALUES (${appId}, ${appId}, now())
    ON CONFLICT (id) DO UPDATE SET hidden_at = now()`;
};

export type AppListingEntry = Omit<KnownApp, "firstSeenAt"> & {
  firstSeenAt: string | null;
  source: Array<"registry" | "remembered" | "core-data" | "provider">;
  live: AppRegistryDetail | null;
  providers: ProviderRef[];
};

/** Hidden entries suppress retained Core data and provider hints until a live lease returns. */
export const listAppListing = async (
  params: { liveApps?: AppRegistryDetail[]; otherApps?: AppStatusSummaries["otherApps"] } = {},
): Promise<AppListingEntry[]> => {
  const liveApps = params.liveApps ?? (await readAppRegistrySnapshot()).apps;
  await rememberApps(liveApps);
  const [known, dataApps] = await Promise.all([
    listKnownApps(),
    sql<{ id: string }[]>`
      SELECT DISTINCT app_id AS id FROM auth.service_accounts WHERE app_id IS NOT NULL
      UNION SELECT app_id AS id FROM auth.app_access_state
      UNION SELECT app_id AS id FROM events.app_subscriptions`,
  ]);
  const hidden = new Set(known.filter((app) => app.hidden).map((app) => app.id));
  const entries = new Map<string, AppListingEntry>();
  for (const app of known) if (!app.hidden) entries.set(app.id, { ...app, source: ["remembered"], live: null, providers: [] });
  const ensure = (id: string) => {
    let entry = entries.get(id);
    if (!entry) {
      entry = {
        id,
        name: id,
        description: "",
        icon: "ti ti-app",
        accent: null,
        release: null,
        routes: [],
        navHref: null,
        adminHref: null,
        firstSeenAt: null,
        lastSeenAt: null,
        hidden: false,
        source: [],
        live: null,
        providers: [],
      };
      entries.set(id, entry);
    }
    return entry;
  };
  for (const app of liveApps) {
    const entry = ensure(app.id);
    Object.assign(entry, {
      name: app.name,
      description: app.description,
      icon: app.icon,
      accent: app.appearance?.accent ?? null,
      release: app.runtime?.version ?? app.runtime?.release ?? null,
      routes: [...app.routes],
      navHref: app.nav?.href || null,
      adminHref: app.nav?.adminHref ?? null,
      live: app,
      hidden: false,
      lastSeenAt: new Date(app.updatedAt).toISOString(),
    });
    entry.source.push("registry");
  }
  for (const app of dataApps) if (!hidden.has(app.id)) ensure(app.id).source.push("core-data");
  for (const app of params.otherApps ?? []) {
    if (hidden.has(app.appId) && !liveApps.some((live) => live.id === app.appId)) continue;
    const entry = ensure(app.appId);
    if (!entry.source.includes("provider")) entry.source.push("provider");
    if (!entry.providers.some((provider) => provider.appId === app.provider.appId)) entry.providers.push(app.provider);
    if (!entry.lastSeenAt || (app.lastSeenAt && Date.parse(app.lastSeenAt) > Date.parse(entry.lastSeenAt)))
      entry.lastSeenAt = app.lastSeenAt;
  }
  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
};
