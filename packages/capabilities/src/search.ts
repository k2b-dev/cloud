import { listCapabilityCatalog, type CapabilityCatalogApp } from "@k2b/cloud/capabilities/server";
import type { CloudResourceView, UniversalSearchInput } from "@k2b/cloud/contracts";
import { cache } from "@k2b/stdlib";
import { capabilityHref } from "./routes";

export const capabilitySearchViews = (apps: readonly CapabilityCatalogApp[]): CloudResourceView[] =>
  apps.flatMap((app) => [
    {
      ref: { type: "capabilities.app", id: app.appId },
      title: app.appName,
      preview: app.appDescription,
      icon: app.appIcon || "ti ti-apps",
      priority: 1,
      links: [{ rel: "open", href: capabilityHref({ appId: app.appId }) }],
    },
    ...(["query", "action"] as const).flatMap((kind) =>
      (kind === "query" ? app.manifest.queries : app.manifest.actions).map(
        (operation): CloudResourceView => ({
          ref: { type: "capabilities.operation", id: `${app.appId}/${kind}/${operation.localId}` },
          title: operation.title,
          preview: operation.description,
          icon: kind === "query" ? "ti ti-search" : "ti ti-bolt",
          priority: 1,
          metadata: [
            { label: "App", value: app.appName },
            { label: "ID", value: `${app.appId}.${operation.localId}` },
            { label: "Type", value: kind === "query" ? "Query" : "Action" },
          ],
          links: [{ rel: "open", href: capabilityHref({ appId: app.appId, kind, capabilityId: operation.localId }) }],
        }),
      ),
    ),
  ]);

// Only public catalog presentation is shared, never execution permissions or user data.
// Two locale keys and a short TTL keep discovery bounded and current while typing.
export const createSearchCatalogLoader = (readCatalog: typeof listCapabilityCatalog) => {
  const snapshots = cache.create<CloudResourceView[]>({
    ttl: 30_000,
    onMiss: async (locale) => {
      const apps: CapabilityCatalogApp[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await readCatalog({ cursor, limit: 25, locale });
        if (!page.ok) throw new Error(page.error.message);
        apps.push(...page.data.apps);
        if (!page.data.page.hasMore) break;
        cursor = page.data.page.nextCursor;
        if (!cursor || seen.has(cursor)) throw new Error("Capability catalog cursor did not advance");
        seen.add(cursor);
      } while (cursor);
      return capabilitySearchViews(apps);
    },
  });
  return async (locale: string): Promise<CloudResourceView[]> =>
    (await snapshots.get(locale.toLowerCase().startsWith("de") ? "de" : "en")) ?? [];
};
export const loadSearchCatalog = createSearchCatalogLoader(listCapabilityCatalog);

export const filterSearchCatalog = (views: readonly CloudResourceView[], input: UniversalSearchInput): CloudResourceView[] => {
  const words = input.query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return views
    .filter((view) => {
      const haystack =
        `${view.title} ${view.preview ?? ""} ${view.metadata?.map((entry) => entry.value).join(" ") ?? ""}`.toLocaleLowerCase();
      return words.every((word) => haystack.includes(word));
    })
    .slice(0, input.limit);
};
