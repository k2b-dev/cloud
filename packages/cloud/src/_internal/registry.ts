import type { EphemeralConfig } from "@k2b/sync";
import type { AppAppearanceColor } from "../contracts/app";
import type { CapabilityManifest, CapabilityPresentationCatalog } from "../contracts/capabilities";
import type { AppRegistryEntry, CapabilityRegistryEntry, HelpRegistryEntry } from "../contracts/registry";
import type { DashboardWidgetPresentation } from "../contracts/widgets";
import { resolveAppPresentations } from "../shared/app-presentation";
import { compileCapabilityPresentation, parseCapabilityManifest } from "./capabilities";
import { lazySync } from "./process-sync";
import { validateAppRegistryEntry } from "./registry-validation";

/**
 * Shared app registry: three @k2b/sync ephemerals on the process Sync
 * instance. Apps, the gateway, and gateway-ops all declare them through the
 * functions below, so id, owner, TTL, and value bound stay identical across
 * the fleet (a differing declaration fails with ResourceDriftError).
 *
 * TTL is 3× the heartbeat interval (see `./heartbeat.ts`).
 */
export const APP_REGISTRY_TTL_MS = 180_000;
const REGISTRY_OWNER = "cloud";

export const APP_REGISTRY_CONFIG = {
  id: "cloud-apps",
  owner: REGISTRY_OWNER,
  ttlMs: APP_REGISTRY_TTL_MS,
  maxValueBytes: 64 * 1024,
} as const satisfies EphemeralConfig;

export const CAPABILITY_REGISTRY_CONFIG = {
  id: "cloud-capabilities",
  owner: REGISTRY_OWNER,
  ttlMs: APP_REGISTRY_TTL_MS,
  maxValueBytes: 512 * 1024,
} as const satisfies EphemeralConfig;

export const HELP_REGISTRY_CONFIG = {
  id: "cloud-help",
  owner: REGISTRY_OWNER,
  ttlMs: APP_REGISTRY_TTL_MS,
  maxValueBytes: 512 * 1024,
} as const satisfies EphemeralConfig;

export const APP_REGISTRY_PREFIX = "apps/";

export type CapabilityRegistryRecord = { appId: string; manifest: CapabilityManifest; presentation?: CapabilityPresentationCatalog };

export const appRegistry = lazySync((sync) => sync.ephemeral<AppRegistryEntry>(APP_REGISTRY_CONFIG));
export const capabilityRegistry = lazySync((sync) => sync.ephemeral<CapabilityRegistryRecord>(CAPABILITY_REGISTRY_CONFIG));
export const helpRegistry = lazySync((sync) => sync.ephemeral<HelpRegistryEntry>(HELP_REGISTRY_CONFIG));

/**
 * Follow the app registry until `signal` aborts. The watch first replays the
 * current entries, then streams changes; `onChange` runs once per event and
 * is awaited (events queue meanwhile). A `resync_required` event (history no
 * longer covers the watch) restarts the watch, which replays again.
 */
export const watchAppRegistry = async ({ signal, onChange }: { signal: AbortSignal; onChange: () => Promise<void> }): Promise<void> => {
  const registry = appRegistry();
  while (!signal.aborted) {
    for await (const event of registry.watch({ prefix: APP_REGISTRY_PREFIX, signal })) {
      if (event.type === "resync_required") break;
      await onChange();
    }
  }
};

/**
 * App entry enriched with registry metadata.
 * `createdAt` = process start reported by the app (uptime anchor).
 * `updatedAt` = most recent heartbeat touch; `expiresAt` = `updatedAt` + TTL.
 * `version` = the entry's registry revision.
 */
export type AppRegistryDetail = AppRegistryEntry & {
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  version: string;
};

export type AppRegistryIssue = {
  key: string;
  version: string;
  reason: string;
};

export type AppRegistrySnapshot = {
  apps: AppRegistryDetail[];
  issues: AppRegistryIssue[];
};

const loggedInvalidReasons = new Map<string, string>();

const reportInvalidEntry = (issue: AppRegistryIssue): void => {
  if (loggedInvalidReasons.get(issue.key) === issue.reason) return;
  loggedInvalidReasons.set(issue.key, issue.reason);
  console.error(
    JSON.stringify({
      level: "error",
      source: "app-registry",
      message: "Rejected invalid app registry entry",
      registryKey: issue.key,
      registryVersion: issue.version,
      reason: issue.reason,
    }),
  );
};

export const readAppRegistrySnapshot = async (): Promise<AppRegistrySnapshot> => {
  const snapshot = await appRegistry().snapshot({ prefix: APP_REGISTRY_PREFIX });
  const apps: AppRegistryDetail[] = [];
  const issues: AppRegistryIssue[] = [];
  const presentKeys = new Set<string>();

  for (const entry of snapshot.entries) {
    presentKeys.add(entry.key);
    const expectedKey =
      entry.value && typeof entry.value === "object" && "id" in entry.value ? `${APP_REGISTRY_PREFIX}${String(entry.value.id)}` : undefined;
    const reason = entry.key !== expectedKey ? "registry key must match entry id" : validateAppRegistryEntry(entry.value);
    if (reason) {
      const issue = { key: entry.key, version: entry.revision, reason };
      issues.push(issue);
      reportInvalidEntry(issue);
      continue;
    }
    loggedInvalidReasons.delete(entry.key);
    const value = entry.value as AppRegistryEntry;
    const updatedAt = entry.updatedAt.getTime();
    apps.push({
      ...value,
      createdAt: value.startedAt ?? updatedAt,
      updatedAt,
      expiresAt: updatedAt + APP_REGISTRY_TTL_MS,
      version: entry.revision,
    });
  }

  for (const key of loggedInvalidReasons.keys()) {
    if (!presentKeys.has(key)) loggedInvalidReasons.delete(key);
  }
  return { apps, issues };
};

export const requireUsableAppRegistry = (snapshot: AppRegistrySnapshot): AppRegistryDetail[] => {
  if (snapshot.apps.length === 0 && snapshot.issues.length > 0) {
    throw new Error(`App registry contains no valid entries (${snapshot.issues.length} rejected)`);
  }
  return snapshot.apps;
};

/**
 * List all currently live (TTL-valid) app registry entries.
 */
export const listApps = async (): Promise<AppRegistryEntry[]> => {
  const snapshot = await readAppRegistrySnapshot();
  return requireUsableAppRegistry(snapshot);
};

/** Reads one live app without materializing the full registry. */
export const getApp = async (appId: string): Promise<AppRegistryEntry | null> => {
  const key = `${APP_REGISTRY_PREFIX}${appId}`;
  const snap = await appRegistry().snapshot({ prefix: key });
  const entry = snap.entries.find((candidate) => candidate.key === key);
  if (!entry) return null;
  const reason =
    !entry.value || typeof entry.value !== "object" || !("id" in entry.value) || entry.value.id !== appId
      ? "registry key must match entry id"
      : validateAppRegistryEntry(entry.value);
  if (!reason) {
    loggedInvalidReasons.delete(key);
    return entry.value;
  }
  reportInvalidEntry({ key, version: entry.revision, reason });
  return null;
};

const capabilityEndpoint = (baseUrl: string): string | null => {
  try {
    const base = new URL(baseUrl);
    if (!(["http:", "https:"] as const).includes(base.protocol as "http:" | "https:") || base.username || base.password) return null;
    return new URL("/api/_internal/capabilities/v1", base).toString();
  } catch {
    return null;
  }
};

const appAccent = (value: string | undefined): AppAppearanceColor | undefined =>
  /^#[0-9a-f]{6}$/i.test(value ?? "") ? (value as AppAppearanceColor) : undefined;

export const resolveLiveCapabilityRegistryEntry = (
  key: string,
  value: unknown,
  app: AppRegistryEntry | undefined,
): CapabilityRegistryEntry | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).some((field) => field !== "appId" && field !== "manifest" && field !== "presentation")) return null;
  const record = value as Partial<CapabilityRegistryRecord>;
  if (!app || typeof record.appId !== "string" || key !== `capabilities/${record.appId}` || record.appId !== app.id) return null;
  if (!app.capabilities) return null;
  const endpoint = capabilityEndpoint(app.baseUrl);
  if (!endpoint) return null;
  try {
    const manifest = parseCapabilityManifest(record.manifest, app.id);
    const presentation = compileCapabilityPresentation(manifest, record.presentation);
    if (app.capabilities.protocolVersion !== manifest.protocolVersion || app.capabilities.manifestHash !== manifest.manifestHash) {
      return null;
    }
    return {
      appId: app.id,
      appName: app.name,
      appIcon: app.icon,
      appAccent: appAccent(app.appearance?.accent),
      appDescription: app.description,
      endpoint,
      manifest,
      presentation,
    };
  } catch {
    return null;
  }
};

export const listCapabilities = async (): Promise<CapabilityRegistryEntry[]> => {
  const [snap, apps] = await Promise.all([capabilityRegistry().snapshot({ prefix: "capabilities/" }), listApps()]);
  const byId = new Map(apps.map((app) => [app.id, app]));
  return snap.entries.flatMap((entry) => {
    const appId = entry.key.startsWith("capabilities/") ? entry.key.slice("capabilities/".length) : "";
    const capability = resolveLiveCapabilityRegistryEntry(entry.key, entry.value, byId.get(appId));
    return capability ? [capability] : [];
  });
};

export const getCapability = async (appId: string): Promise<CapabilityRegistryEntry | null> => {
  const key = `capabilities/${appId}`;
  const [snap, app] = await Promise.all([capabilityRegistry().snapshot({ prefix: key }), getApp(appId)]);
  const entry = snap.entries.find((candidate) => candidate.key === key);
  return entry ? resolveLiveCapabilityRegistryEntry(entry.key, entry.value, app ?? undefined) : null;
};

const isHelpRegistryEntry = (value: unknown): value is HelpRegistryEntry => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<HelpRegistryEntry>;
  const validDocument = (document: unknown) =>
    !!document &&
    typeof document === "object" &&
    typeof (document as { id?: unknown }).id === "string" &&
    typeof (document as { title?: unknown }).title === "string" &&
    typeof (document as { order?: unknown }).order === "number" &&
    typeof (document as { markdown?: unknown }).markdown === "string" &&
    ((document as { searchText?: unknown }).searchText === undefined ||
      typeof (document as { searchText?: unknown }).searchText === "string") &&
    ((document as { icon?: unknown }).icon === undefined || typeof (document as { icon?: unknown }).icon === "string") &&
    ((document as { description?: unknown }).description === undefined ||
      typeof (document as { description?: unknown }).description === "string");
  return (
    typeof entry.appId === "string" &&
    typeof entry.appName === "string" &&
    typeof entry.appIcon === "string" &&
    typeof entry.manifestHash === "string" &&
    (entry.baseLocale === undefined || typeof entry.baseLocale === "string") &&
    Array.isArray(entry.documents) &&
    entry.documents.every(validDocument) &&
    (entry.documentsByLocale === undefined ||
      (!!entry.documentsByLocale &&
        typeof entry.documentsByLocale === "object" &&
        !Array.isArray(entry.documentsByLocale) &&
        Object.values(entry.documentsByLocale).every((documents) => Array.isArray(documents) && documents.every(validDocument))))
  );
};

export const listHelp = async (): Promise<HelpRegistryEntry[]> => {
  const snap = await helpRegistry().snapshot({ prefix: "help/" });
  return snap.entries.map((entry) => entry.value).filter(isHelpRegistryEntry);
};

export const getHelp = async (appId: string): Promise<HelpRegistryEntry | null> => {
  const key = `help/${appId}`;
  const snap = await helpRegistry().snapshot({ prefix: key });
  const value = snap.entries.find((entry) => entry.key === key)?.value;
  return isHelpRegistryEntry(value) ? value : null;
};

/**
 * Same as `listApps` but returns registry metadata for admin observability.
 */
export const listAppsDetailed = async (): Promise<AppRegistryDetail[]> => {
  const snapshot = await readAppRegistrySnapshot();
  return snapshot.apps;
};

/**
 * Aggregate every running app's `legalLinks` into one flat list. Used by the
 * login footer, app Footer, and rail "more" dropdown to render a unified set
 * of legal/info links (Imprint, Privacy, Terms, FAQ, …).
 *
 * Order = registration order across apps (no explicit weights — KISS). Within
 * one app, declaration order is preserved. Duplicate `href`s are de-duped
 * (last-seen wins).
 */
export const listLegalLinks = async (locale?: string): Promise<Array<{ label: string; href: string; icon?: string }>> => {
  const registeredApps = await listApps();
  const apps = locale ? resolveAppPresentations(registeredApps, locale) : registeredApps;
  const seen = new Map<string, { label: string; href: string; icon?: string }>();
  for (const app of apps) {
    for (const link of app.legalLinks ?? []) seen.set(link.href, { ...link });
  }
  return [...seen.values()];
};

/**
 * Aggregate every running app's widget endpoints into one flat list. Used by
 * the dashboard app to build the widget grid and for Core to resolve the
 * exact target before proxying a widget request.
 *
 * Order = registration order across apps.
 */
export type DashboardWidget = {
  appId: string;
  appName: string;
  appIcon: string;
  widgetId: string;
  /** Fully-qualified URL — `<baseUrl>/<path>`. */
  url: string;
  presentation?: DashboardWidgetPresentation;
};

export const listWidgets = async (): Promise<DashboardWidget[]> => {
  const apps = await listApps();
  const out: DashboardWidget[] = [];
  for (const app of apps) {
    for (const w of app.widgets ?? []) {
      out.push({
        appId: app.id,
        appName: app.name,
        appIcon: app.icon,
        widgetId: w.id,
        url: `${app.baseUrl.replace(/\/$/, "")}${w.path.startsWith("/") ? w.path : `/${w.path}`}`,
        presentation: w.presentation,
      });
    }
  }
  return out;
};
