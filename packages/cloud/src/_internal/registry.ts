import { createHash } from "node:crypto";
import type { Ephemeral, EphemeralConfig, EphemeralEntry, MutexConfig } from "@k2b/sync";
import type { AppAppearanceColor } from "../contracts/app";
import { appStatusIssues } from "../contracts/app-status";
import { calendarSourceIssues } from "../contracts/calendar-source";
import type { CapabilityManifest, CapabilityPresentationCatalog } from "../contracts/capabilities";
import { discussionsIssues } from "../contracts/discussions";
import { fileProviderIssues } from "../contracts/file-provider";
import type { AppRegistryEntry, CapabilityRegistryEntry } from "../contracts/registry";
import { resourcePageIssue } from "../contracts/resource-pages";
import { type Role, RoleSchema } from "../contracts/shared";
import {
  type DashboardWidgetPresentation,
  type DashboardWidgetSize,
  resolveWidgetSizes,
  WIDGET_DESCRIPTION_MAX_LENGTH,
  WIDGET_TITLE_MAX_LENGTH,
  type WidgetSettingsDeclaration,
} from "../contracts/widgets";
import type { PlatformBootstrapMetadata } from "../runtime/connections";
import { resolveAppPresentations } from "../shared/app-presentation";
import { compileCapabilityPresentation, parseCapabilityManifest } from "./capabilities";
import { createObservedView, freezeObserved } from "./observed-view";
import { lazySync, processSyncReaders } from "./process-sync";
import { parseAppRegistryEntry } from "./registry-validation";
import { watchRegistryChanges } from "./registry-watch";
import { WidgetSettingsDeclarationSchema } from "./widget-settings";

/**
 * Shared app registry: two @k2b/sync ephemerals on the process Sync
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

export const APP_REGISTRY_PREFIX = "apps/";
export const APP_INSTANCE_PREFIX = "instances/";

// Fit Sync's 96-byte name limit for every app id that fits apps/<id>; appId stays in the record value.
export const appInstancePrefix = (appId: string): string => {
  const segment = createHash("sha256").update(appId).digest("base64url").slice(0, 16);
  return `${APP_INSTANCE_PREFIX}${segment}/`;
};

export type AppInstanceRecord = {
  appId: string;
  instanceId: string;
  hostname: string;
  startedAt: number;
  entries: Record<string, string>;
  /** Missing on older instances means unknown, never env or successful bootstrap. */
  bootstrap?: PlatformBootstrapMetadata;
  /** Core can durably observe both accepted legacy identity paths. */
  legacyEvidence?: 1;
};

// The id and owner are a cross-version contract: all replicas must use the same lock.
// TTL and retry are local budgets; Sync's drift identity is [id, owner, replicas].
export const APP_MEMBERSHIP_LOCK_CONFIG = {
  id: "cloud-app-membership",
  owner: REGISTRY_OWNER,
  retry: { delayMs: 200, maxAttempts: 50 },
} as const satisfies MutexConfig;

export const appInstanceRegistry = lazySync((sync) => sync.ephemeral<AppInstanceRecord>(APP_REGISTRY_CONFIG));
export const appMembershipLock = lazySync((sync) => sync.mutex(APP_MEMBERSHIP_LOCK_CONFIG));

export type CapabilityRegistryRecord = { appId: string; manifest: CapabilityManifest; presentation?: CapabilityPresentationCatalog };

type RegistryWriter<T> = Pick<ReturnType<typeof createObservedView<T, unknown>>, "accept" | "reconcile" | "invalidate">;

/** Local acknowledgements update only their key; remote mutations arrive through the watch. */
const observedRegistry = <T>(config: EphemeralConfig) => {
  const context = lazySync((sync) => {
    const registry = sync.ephemeral<T>(config);
    let view: RegistryWriter<T> | undefined;
    const mutation = async <R>(
      input: { key: string; tenantId?: string },
      write: () => Promise<R>,
      accept: (result: R) => Promise<void> | void,
    ) => {
      try {
        const result = await write();
        if (!input.tenantId || input.tenantId === "default") await accept(result);
        return result;
      } catch (error) {
        view?.invalidate();
        throw error;
      }
    };
    const published: Ephemeral<T> = {
      ...registry,
      upsert: (input) =>
        mutation(
          input,
          () => registry.upsert(input),
          (entry) => view?.accept(entry),
        ),
      touch: (input) =>
        mutation(
          input,
          () => registry.touch(input),
          () => view?.reconcile(input.key),
        ),
      delete: (input) =>
        mutation(
          input,
          () => registry.delete(input),
          () => view?.reconcile(input.key),
        ),
    };
    return {
      published,
      observe: (observed: RegistryWriter<T>) => {
        view = observed;
      },
    };
  });
  return { published: () => context().published, observe: (view: RegistryWriter<T>) => context().observe(view) };
};
const appsObserved = observedRegistry<AppRegistryEntry>(APP_REGISTRY_CONFIG);
const capabilitiesObserved = observedRegistry<CapabilityRegistryRecord>(CAPABILITY_REGISTRY_CONFIG);
export const appRegistry = appsObserved.published;
export const capabilityRegistry = capabilitiesObserved.published;

/**
 * Follow the app registry until `signal` aborts. The watch first replays the
 * current entries, then streams changes. While a refresh runs, further events
 * coalesce into one follow-up refresh. Resync also refreshes an empty registry.
 * Shutdown waits for received invalidations; refresh errors stop the watch.
 */
export const watchAppRegistry = async ({ signal, onChange }: { signal: AbortSignal; onChange: () => Promise<void> }): Promise<void> => {
  const view = observedApps();
  await watchRegistryChanges({ signal, onChange, watch: (signal) => view.changes(signal) });
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
  /** Per-process startup metadata for admin readers. null means an older/unknown producer. */
  instances?: { instanceId: string; hostname: string; startedAt: number; bootstrap: PlatformBootstrapMetadata | null }[];
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

/** Own transport invalidation and cleanup identically for every observed registry. */
const processObservedView = <T, V>(source: () => Ephemeral<T>, prefix: string, read: (entry: EphemeralEntry<T>) => V) =>
  lazySync(() => {
    const readers = processSyncReaders();
    const view = createObservedView({ registry: source(), prefix, ttlMs: APP_REGISTRY_TTL_MS, signal: readers.signal, read });
    const status = readers.connection?.status()[Symbol.asyncIterator]();
    const statusTask = status
      ? (async () => {
          for (;;) {
            const next = await status.next();
            if (next.done || readers.signal.aborted) break;
            if (["disconnect", "reconnect", "reconnecting", "staleConnection", "close"].includes(next.value.type)) view.invalidate();
          }
        })()
      : undefined;
    void readers.connection?.closed().then(() => view.invalidate());
    const stop = async () => {
      await view.stop();
      // return() cannot interrupt a pending NATS status next(); transport drain closes it.
      void statusTask?.finally(() => status?.return?.());
      readers.stops.delete(stop);
    };
    readers.stops.add(stop);
    return view;
  });

type ObservedApp = { app: AppRegistryEntry; issue?: never } | { app?: never; issue: string };
const appRegistryView = processObservedView(appRegistry, APP_REGISTRY_PREFIX, (entry): ObservedApp => {
  const parsed = parseAppRegistryEntry(entry.value);
  const reason = parsed.reason ?? (entry.key !== `${APP_REGISTRY_PREFIX}${parsed.value.id}` ? "registry key must match entry id" : null);
  if (reason || !parsed.value) {
    const issue = { key: entry.key, version: entry.revision, reason: reason ?? "invalid entry" };
    reportInvalidEntry(issue);
    return { issue: issue.reason };
  }
  loggedInvalidReasons.delete(entry.key);
  return { app: parsed.value };
});
const observedApps = () => {
  // Initialize the published handle before attaching its local write-through view.
  appRegistry();
  const view = appRegistryView();
  appsObserved.observe(view);
  return view;
};
const capabilityRegistryView = processObservedView(capabilityRegistry, "capabilities/", (entry) => entry.value);
const observedCapabilities = () => {
  capabilityRegistry();
  const view = capabilityRegistryView();
  capabilitiesObserved.observe(view);
  return view;
};

export const readAppRegistrySnapshot = async (): Promise<AppRegistrySnapshot> => {
  const entries = await observedApps().entries();
  const apps = entries.flatMap((entry) =>
    entry.value.app
      ? [
          {
            ...entry.value.app,
            createdAt: entry.value.app.startedAt ?? entry.updatedAt.getTime(),
            updatedAt: entry.updatedAt.getTime(),
            expiresAt: entry.updatedAt.getTime() + APP_REGISTRY_TTL_MS,
            version: entry.revision,
          },
        ]
      : [],
  );
  const issues = entries.flatMap((entry) =>
    entry.value.issue ? [{ key: entry.key, version: entry.revision, reason: entry.value.issue }] : [],
  );
  const keys = new Set(entries.map((entry) => entry.key));
  for (const key of loggedInvalidReasons.keys()) if (!keys.has(key)) loggedInvalidReasons.delete(key);
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
  const values = await observedApps().values();
  const apps = values.flatMap((value) => (value.app ? [value.app] : []));
  if (!apps.length && values.some((value) => value.issue))
    throw new Error(`App registry contains no valid entries (${values.length} rejected)`);
  return apps;
};

/** Reads one live app from the process-owned registry view. */
export const getApp = async (appId: string): Promise<AppRegistryEntry | null> => {
  return (await observedApps().get(`${APP_REGISTRY_PREFIX}${appId}`))?.app ?? null;
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

/** Last manifest per app whose left-out entries were checked, so each registered manifest logs once. */
const checkedLeftOutEntries = new Map<string, string>();

/**
 * Logs the entries of a registered manifest that this release left out, typically because the app runs a
 * newer Cloud release. Core answers those operations as not found, so the operator needs their names.
 * A left-out file provider is named too, because the app then quietly stops offering files. `manifest` is
 * the manifest as read, before the file-provider contract check, which logs its own rejections.
 */
const reportLeftOutEntries = (sent: unknown, manifest: CapabilityManifest): void => {
  if (checkedLeftOutEntries.get(manifest.appId) === manifest.manifestHash) return;
  checkedLeftOutEntries.set(manifest.appId, manifest.manifestHash);
  const kept = new Set([...manifest.types, ...manifest.queries, ...manifest.actions, ...manifest.commands].map((entry) => entry.localId));
  const groups = sent as Record<string, unknown>;
  const leftOut = (["types", "queries", "actions", "commands"] as const).flatMap((group) => {
    const entries = groups[group];
    if (!Array.isArray(entries)) return [];
    return entries.flatMap((entry: unknown) => {
      const localId = entry && typeof entry === "object" ? (entry as { localId?: unknown }).localId : undefined;
      return typeof localId === "string" && !kept.has(localId) ? [`${group}/${localId}`] : [];
    });
  });
  if (groups.calendarSource !== undefined && !manifest.calendarSource) leftOut.push("calendarSource");
  if (groups.fileProvider !== undefined && !manifest.fileProvider) leftOut.push("fileProvider");
  if (groups.appStatus !== undefined && !manifest.appStatus) leftOut.push("appStatus");
  if (groups.discussions !== undefined && !manifest.discussions) leftOut.push("discussions");
  if (leftOut.length === 0) return;
  console.warn(
    JSON.stringify({
      level: "warn",
      source: "capability-registry",
      message: "Left out capability entries this Cloud release cannot read",
      appId: manifest.appId,
      manifestHash: manifest.manifestHash,
      leftOutCount: leftOut.length,
      leftOut: leftOut.slice(0, 20),
    }),
  );
};

/** Last checked manifest per app: its hash and whether its file provider passed the contract check. */
const checkedFileProviders = new Map<string, { manifestHash: string; valid: boolean }>();

/**
 * Ignores a file provider that does not match the contract, logging once per manifest; the app's other
 * capabilities stay available. The delivered `manifestHash` stays, because it identifies what the app registered.
 */
const withValidFileProvider = (manifest: CapabilityManifest): CapabilityManifest => {
  if (!manifest.fileProvider) return manifest;
  const checked = checkedFileProviders.get(manifest.appId);
  let valid = checked?.manifestHash === manifest.manifestHash ? checked.valid : undefined;
  if (valid === undefined) {
    const issues = fileProviderIssues(manifest);
    valid = issues.length === 0;
    checkedFileProviders.set(manifest.appId, { manifestHash: manifest.manifestHash, valid });
    if (!valid) {
      console.error(
        JSON.stringify({
          level: "error",
          source: "capability-registry",
          message: "Ignored a file provider that does not match the file-provider contract",
          appId: manifest.appId,
          manifestHash: manifest.manifestHash,
          issues: issues
            .slice(0, 10)
            .map(({ function: name, localId, code, path, message }) => ({ function: name, localId, code, path, message })),
        }),
      );
    }
  }
  if (valid) return manifest;
  const { fileProvider: _ignored, ...rest } = manifest;
  return rest;
};

const checkedCalendarSources = new Map<string, { manifestHash: string; valid: boolean }>();

/**
 * Ignores a calendar source that does not match the contract, logging once per manifest; the app's other
 * capabilities stay available. The delivered `manifestHash` stays, because it identifies what the app registered.
 */
const withValidCalendarSource = (manifest: CapabilityManifest): CapabilityManifest => {
  if (!manifest.calendarSource) return manifest;
  const checked = checkedCalendarSources.get(manifest.appId);
  let valid = checked?.manifestHash === manifest.manifestHash ? checked.valid : undefined;
  if (valid === undefined) {
    const issues = calendarSourceIssues(manifest);
    valid = issues.length === 0;
    checkedCalendarSources.set(manifest.appId, { manifestHash: manifest.manifestHash, valid });
    if (!valid) {
      console.error(
        JSON.stringify({
          level: "error",
          source: "capability-registry",
          message: "Ignored a calendar source that does not match the calendar-source contract",
          appId: manifest.appId,
          manifestHash: manifest.manifestHash,
          issues: issues
            .slice(0, 10)
            .map(({ function: name, localId, code, path, message }) => ({ function: name, localId, code, path, message })),
        }),
      );
    }
  }
  if (valid) return manifest;
  const { calendarSource: _ignored, ...rest } = manifest;
  return rest;
};

const checkedDiscussions = new Map<string, { manifestHash: string; valid: boolean }>();
const withValidDiscussions = (manifest: CapabilityManifest): CapabilityManifest => {
  if (!manifest.discussions) return manifest;
  const checked = checkedDiscussions.get(manifest.appId);
  let valid = checked?.manifestHash === manifest.manifestHash ? checked.valid : undefined;
  if (valid === undefined) {
    const issues = discussionsIssues(manifest);
    valid = issues.length === 0;
    checkedDiscussions.set(manifest.appId, { manifestHash: manifest.manifestHash, valid });
    if (!valid)
      console.error(
        JSON.stringify({
          level: "error",
          source: "capability-registry",
          message: "Ignored an incompatible discussions provider",
          appId: manifest.appId,
          manifestHash: manifest.manifestHash,
          issues,
        }),
      );
  }
  if (valid) return manifest;
  const { discussions: _ignored, ...rest } = manifest;
  return rest;
};

const checkedAppStatus = new Map<string, { manifestHash: string; valid: boolean }>();
const withValidAppStatus = (manifest: CapabilityManifest): CapabilityManifest => {
  if (!manifest.appStatus) return manifest;
  const checked = checkedAppStatus.get(manifest.appId);
  let valid = checked?.manifestHash === manifest.manifestHash ? checked.valid : undefined;
  if (valid === undefined) {
    const issues = appStatusIssues(manifest);
    valid = issues.length === 0;
    checkedAppStatus.set(manifest.appId, { manifestHash: manifest.manifestHash, valid });
    if (!valid)
      console.error(
        JSON.stringify({
          level: "error",
          source: "capability-registry",
          message: "Ignored an incompatible appStatus provider",
          appId: manifest.appId,
          manifestHash: manifest.manifestHash,
          issues,
        }),
      );
  }
  if (valid) return manifest;
  const { appStatus: _ignored, ...rest } = manifest;
  return rest;
};

/** Ignores record fields from a newer release; the endpoint always comes from the live app registry. */
export const resolveLiveCapabilityRegistryEntry = (
  key: string,
  value: unknown,
  app: AppRegistryEntry | undefined,
): CapabilityRegistryEntry | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<CapabilityRegistryRecord>;
  if (!app || typeof record.appId !== "string" || key !== `capabilities/${record.appId}` || record.appId !== app.id) return null;
  if (!app.capabilities) return null;
  const endpoint = capabilityEndpoint(app.baseUrl);
  if (!endpoint) return null;
  try {
    const read = parseCapabilityManifest(record.manifest, app.id);
    const supported = withValidAppStatus(withValidDiscussions(withValidCalendarSource(withValidFileProvider(read))));
    const manifest = supported.resourcePages
      ? {
          ...supported,
          resourcePages: supported.resourcePages.filter((page) => !resourcePageIssue(page.path, app.routes, app.id)),
        }
      : supported;
    const presentation = compileCapabilityPresentation(manifest, record.presentation, "reader");
    if (app.capabilities.protocolVersion !== manifest.protocolVersion || app.capabilities.manifestHash !== manifest.manifestHash) {
      return null;
    }
    reportLeftOutEntries(record.manifest, read);
    return {
      appId: app.id,
      appName: app.name,
      appIcon: app.icon,
      appAccent: appAccent(app.appearance?.accent),
      appDescription: app.description,
      endpoint,
      manifest,
      presentation,
      ...(app.presentation ? { appPresentation: app.presentation } : {}),
    };
  } catch {
    return null;
  }
};

// Cache joins by immutable payload identity; lease metadata never invalidates a manifest.
const resolvedCapabilities = new WeakMap<AppRegistryEntry, WeakMap<CapabilityRegistryRecord, CapabilityRegistryEntry | null>>();
const resolveObservedCapability = (key: string, record: CapabilityRegistryRecord, app: AppRegistryEntry | undefined) => {
  if (!app) return null;
  let records = resolvedCapabilities.get(app);
  if (!records) {
    records = new WeakMap();
    resolvedCapabilities.set(app, records);
  }
  if (record && typeof record === "object") {
    if (records.has(record)) return records.get(record) ?? null;
    const resolved = freezeObserved(resolveLiveCapabilityRegistryEntry(key, record, app));
    records.set(record, resolved);
    return resolved;
  }
  return null;
};
export const listCapabilities = async (appSnapshot?: AppRegistryEntry[]): Promise<CapabilityRegistryEntry[]> => {
  const [entries, apps] = await Promise.all([observedCapabilities().entries(), appSnapshot ?? listApps()]);
  const byId = new Map(apps.map((app) => [app.id, app]));
  return entries.flatMap((entry) => {
    const capability = resolveObservedCapability(entry.key, entry.value, byId.get(entry.key.slice("capabilities/".length)));
    return capability ? [capability] : [];
  });
};

export const getCapability = async (appId: string): Promise<CapabilityRegistryEntry | null> => {
  const key = `capabilities/${appId}`;
  const [record, app] = await Promise.all([observedCapabilities().get(key), getApp(appId)]);
  return record ? resolveObservedCapability(key, record, app ?? undefined) : null;
};

/** Internal runtime consumer: one refresh for content changes in either registry. */
export const watchRuntimeRegistry = async ({ signal, onChange }: { signal: AbortSignal; onChange: () => Promise<void> }): Promise<void> => {
  const views = [observedApps(), observedCapabilities()];
  await watchRegistryChanges({
    signal,
    onChange,
    watch: (signal) => ({
      async *[Symbol.asyncIterator]() {
        let dirty = true;
        let wake: (() => void) | undefined;
        const controller = new AbortController();
        const notify = () => {
          dirty = true;
          wake?.();
        };
        const abort = () => {
          controller.abort();
          notify();
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        const tasks = views.map(async (view) => {
          for await (const _ of view.changes(controller.signal, false)) notify();
        });
        try {
          while (!signal.aborted) {
            if (!dirty)
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            if (signal.aborted) break;
            dirty = false;
            yield { type: "change" };
          }
        } finally {
          controller.abort();
          signal.removeEventListener("abort", abort);
          await Promise.all(tasks);
        }
      },
    }),
  });
};

/**
 * Same as `listApps` but returns registry metadata for admin observability.
 */
export const listAppsDetailed = async (): Promise<AppRegistryDetail[]> => {
  const [snapshot, instances] = await Promise.all([
    readAppRegistrySnapshot(),
    appInstanceRegistry().snapshot({ prefix: APP_INSTANCE_PREFIX }),
  ]);
  return snapshot.apps.map((app) => ({
    ...app,
    instances: instances.entries
      .filter(({ value }) => value.appId === app.id)
      .map(({ value }) => ({
        instanceId: value.instanceId,
        hostname: value.hostname,
        startedAt: value.startedAt,
        bootstrap: value.bootstrap ?? null,
      })),
  }));
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
 * Order = registration order across apps. Every optional declaration field is
 * resolved here, so readers never see a registry record from an older app
 * without `title`, `sizes`, or `defaultSize`, nor an unknown size or role.
 */
export type DashboardWidget = {
  appId: string;
  appName: string;
  appIcon: string;
  widgetId: string;
  /** Fully-qualified URL — `<baseUrl>/<path>`. */
  url: string;
  /** The declared title in the requested locale, or the app's name. */
  title: string;
  /** The declared description in the requested locale, or the app's description. */
  description: string;
  sizes: DashboardWidgetSize[];
  defaultSize: DashboardWidgetSize;
  /** Validated setting presentation in the requested locale, absent when none is valid. */
  settings?: WidgetSettingsDeclaration;
  suggest: boolean;
  /** Visibility only, like `nav.requiresRoles`; empty means everyone. */
  requiresRoles: Role[];
  /**
   * @deprecated The zone and width the app recommended before widgets had sizes. Only the dashboard reads it, to
   * convert a board saved then into the board the person saw.
   */
  presentation?: DashboardWidgetPresentation;
};

const LEGACY_ZONES = ["focus", "overview", "context"] as const;
const LEGACY_SPANS = ["standard", "wide"] as const;

const legacyPresentation = (value: DashboardWidgetPresentation | undefined): DashboardWidgetPresentation | undefined => {
  const defaultZone = LEGACY_ZONES.find((zone) => zone === value?.defaultZone);
  const defaultSpan = LEGACY_SPANS.find((span) => span === value?.defaultSpan);
  return defaultZone || defaultSpan ? { defaultZone, defaultSpan } : undefined;
};

const declaredText = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim() && value.trim().length <= max ? value.trim() : undefined;

/** The widgets `apps` declare, resolved as `listWidgets()` returns them. */
export const dashboardWidgetsOf = (apps: readonly AppRegistryEntry[], locale?: string): DashboardWidget[] => {
  const out: DashboardWidget[] = [];
  for (const [index, app] of (locale ? resolveAppPresentations(apps, locale) : apps).entries()) {
    for (const w of app.widgets ?? []) {
      const { sizes, defaultSize } = resolveWidgetSizes(w);
      const translated = WidgetSettingsDeclarationSchema.safeParse(w.settings);
      const original = translated.success
        ? translated
        : WidgetSettingsDeclarationSchema.safeParse(apps[index]?.widgets?.find((widget) => widget.id === w.id)?.settings);
      out.push({
        appId: app.id,
        appName: app.name,
        appIcon: app.icon,
        widgetId: w.id,
        url: `${app.baseUrl.replace(/\/$/, "")}${w.path.startsWith("/") ? w.path : `/${w.path}`}`,
        title: declaredText(w.title, WIDGET_TITLE_MAX_LENGTH) ?? app.name,
        description: declaredText(w.description, WIDGET_DESCRIPTION_MAX_LENGTH) ?? app.description,
        sizes,
        defaultSize,
        ...(original.success ? { settings: original.data } : {}),
        suggest: w.suggest === true,
        requiresRoles: Array.isArray(w.requiresRoles) ? w.requiresRoles.filter((role) => RoleSchema.safeParse(role).success) : [],
        presentation: legacyPresentation(w.presentation),
      });
    }
  }
  return out;
};

/** Every declared widget, with titles and descriptions in `locale` when given. */
export const listWidgets = async (locale?: string): Promise<DashboardWidget[]> => dashboardWidgetsOf(await listApps(), locale);
