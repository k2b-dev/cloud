import { listCapabilityCatalog } from "../capabilities/client";
import { LOCALE_HEADER } from "../shared/locale";

export type CloudSearchTag = {
  appId: string;
  appName: string;
  appIcon: string;
  tag: string;
  title: string;
  description: string;
  aliases: readonly string[];
};

/** What composers read from the page's one Capability catalog load. */
export type CloudComposerCatalog = { tags: readonly CloudSearchTag[] };

const catalogs = new Map<string, Promise<CloudComposerCatalog>>();

const loadCatalog = async (locale: string): Promise<CloudComposerCatalog> => {
  const tags: CloudSearchTag[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const result = await listCapabilityCatalog({ limit: 25, cursor, headers: { [LOCALE_HEADER]: locale } });
    if (!result.ok) throw new Error(result.error.message);
    for (const app of result.data.apps) {
      for (const query of app.manifest.queries) {
        for (const tag of query.universalSearch?.tags ?? []) {
          const key = `${app.appId}\u0000${tag.tag}`;
          if (seen.has(key)) continue;
          seen.add(key);
          tags.push({ appId: app.appId, appName: app.appName, appIcon: app.appIcon, ...tag, aliases: tag.aliases ?? [] });
        }
      }
    }
    const next = result.data.page.hasMore ? result.data.page.nextCursor : undefined;
    if (next && cursor && next <= cursor) throw new Error("Invalid Composer catalog cursor");
    cursor = next;
  } while (cursor);
  return { tags };
};

/**
 * One catalog load per page and locale, shared by every composer on the page. A failed load is forgotten,
 * so the next menu opening can try again; nothing polls or retries on its own.
 */
export const loadCloudComposerCatalog = (locale: string): Promise<CloudComposerCatalog> => {
  const cached = catalogs.get(locale);
  if (cached) return cached;
  const pending = loadCatalog(locale).catch((error: unknown) => {
    if (catalogs.get(locale) === pending) catalogs.delete(locale);
    throw error;
  });
  catalogs.set(locale, pending);
  return pending;
};
