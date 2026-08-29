import type { CapabilityCatalogApp } from "@valentinkolb/cloud/capabilities/server";
import { getCapabilityCatalogApp, listCapabilityCatalog } from "@valentinkolb/cloud/capabilities/server";
import type { CapabilityActionManifest, CapabilityManifest, CapabilityQueryManifest } from "@valentinkolb/cloud/contracts";

const CATALOG_PAGE_SIZE = 25;

export type CapabilityAppSummary = {
  id: string;
  name: string;
  icon: string;
  description: string;
};

type CapabilityAppsPage = {
  apps: CapabilityAppSummary[];
  cursor?: string;
  nextCursor?: string;
};

export type LoadedCapabilityApp =
  | { kind: "ready"; app: CapabilityAppSummary; manifest: CapabilityManifest }
  | { kind: "unavailable"; app: CapabilityAppSummary }
  | { kind: "not-found" };

type SelectedCapabilityBase = {
  app: CapabilityAppSummary;
};

export type SelectedCapability =
  | (SelectedCapabilityBase & { kind: "query"; operation: CapabilityQueryManifest })
  | (SelectedCapabilityBase & { kind: "action"; operation: CapabilityActionManifest });

const summary = (entry: CapabilityCatalogApp): CapabilityAppSummary => ({
  id: entry.appId,
  name: entry.appName,
  icon: entry.appIcon,
  description: entry.appDescription,
});

type CatalogReader = typeof listCapabilityCatalog;
type AppReader = typeof getCapabilityCatalogApp;

const loadAllCapabilityCatalogApps = async (readCatalog: CatalogReader): Promise<CapabilityCatalogApp[]> => {
  const apps = new Map<string, CapabilityCatalogApp>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  while (true) {
    const catalog = await readCatalog({ cursor, limit: CATALOG_PAGE_SIZE });
    if (!catalog.ok) break;
    for (const app of catalog.data.apps) apps.set(app.appId, app);
    if (!catalog.data.page.hasMore) break;

    const nextCursor = catalog.data.page.nextCursor;
    if (seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return [...apps.values()];
};

const parseCursor = (url: URL): string | undefined => {
  const value = url.searchParams.get("cursor")?.trim();
  return value && value.length <= 80 ? value : undefined;
};

export async function loadCapabilityApps(url: URL, locale?: string): Promise<CapabilityAppsPage> {
  const cursor = parseCursor(url);
  const catalog = await listCapabilityCatalog({ cursor, limit: CATALOG_PAGE_SIZE, locale });
  if (!catalog.ok) return { apps: [], cursor };

  return {
    apps: catalog.data.apps.map(summary),
    cursor,
    nextCursor: catalog.data.page.hasMore ? catalog.data.page.nextCursor : undefined,
  };
}

export type LoadedCapabilityWorkspace = {
  apps: CapabilityAppSummary[];
  selected: LoadedCapabilityApp;
};

export async function loadCapabilityWorkspace(
  appId: string,
  readers: { list?: CatalogReader; get?: AppReader } = {},
  locale?: string,
): Promise<LoadedCapabilityWorkspace> {
  const [catalog, selectedCatalog] = await Promise.all([
    loadAllCapabilityCatalogApps((options) => (readers.list ?? listCapabilityCatalog)({ ...options, locale })),
    (readers.get ?? getCapabilityCatalogApp)(appId, locale),
  ]);
  const selectedEntry = selectedCatalog.ok ? selectedCatalog.data : null;
  const apps = [...catalog, ...(selectedEntry && !catalog.some((entry) => entry.appId === appId) ? [selectedEntry] : [])]
    .sort((left, right) => left.appName.localeCompare(right.appName, undefined, { sensitivity: "base" }))
    .map(summary);
  if (!selectedCatalog.ok) {
    return {
      apps,
      selected: { kind: "unavailable", app: { id: appId, name: appId, icon: "ti ti-apps", description: "" } },
    };
  }
  if (!selectedEntry) return { apps, selected: { kind: "not-found" } };
  const app = summary(selectedEntry);
  return { apps, selected: { kind: "ready", app, manifest: selectedEntry.manifest } };
}

export const selectCapability = (
  loaded: Extract<LoadedCapabilityApp, { kind: "ready" }>,
  kind: "query" | "action",
  capabilityId: string,
): SelectedCapability | undefined => {
  if (kind === "query") {
    const operation = loaded.manifest.queries.find((candidate) => candidate.localId === capabilityId);
    return operation ? { app: loaded.app, kind, operation } : undefined;
  }

  const operation = loaded.manifest.actions.find((candidate) => candidate.localId === capabilityId);
  return operation ? { app: loaded.app, kind, operation } : undefined;
};
