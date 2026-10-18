import type { ChatCommandSearch } from "@k2b/ui";
import { createSignal } from "solid-js";
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

/**
 * What composers read from the page's one Capability catalog load. It leaves out the tags of apps without a resource
 * reader: a picker that requires one can show none of their results. A composer that reads such a type itself adds its
 * tag on its own and names the type in `cloudInsertMenu`'s `ownReaders`.
 */
export type CloudComposerCatalog = { tags: readonly CloudSearchTag[] };

/** The budget of one Capability query (and of resolving a Command), applied to each catalog page. */
const CATALOG_PAGE_TIMEOUT_MS = 15_000;

const catalogs = new Map<string, Promise<CloudComposerCatalog>>();

const loadCatalog = async (locale: string): Promise<CloudComposerCatalog> => {
  const tags: CloudSearchTag[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    // A page that never answers fails like any other, so the load is forgotten and the next opening asks again.
    const result = await listCapabilityCatalog({
      limit: 25,
      cursor,
      headers: { [LOCALE_HEADER]: locale },
      signal: AbortSignal.timeout(CATALOG_PAGE_TIMEOUT_MS),
    });
    if (!result.ok) throw new Error(result.error.message);
    for (const app of result.data.apps) {
      if (!app.manifest.types.some((type) => type.reader)) continue;
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

/**
 * The search tags of one composer. Call `ready` at the start of every `searchCommands` run: each menu opening starts
 * the shared load once, so only the first opening, or one after a failure, sends a request, and no keystroke does.
 * A search with typed text and no scope waits for that answer, so "/notiz" never settles as "nothing found" before its
 * tag arrives. The overview and scoped searches do not wait, and after a failed load no search waits again; a later
 * success still brings the tags in. A failure keeps the tags the composer had.
 */
export function createCloudComposerCatalog(load: (locale: string) => Promise<CloudComposerCatalog> = loadCloudComposerCatalog) {
  const [tags, setTags] = createSignal<readonly CloudSearchTag[]>([]);
  let opening: number | undefined;
  let settled: Promise<void> = Promise.resolve();
  let failed = false;
  return {
    tags,
    ready(query: string, search: ChatCommandSearch, locale: string): Promise<void> {
      if (opening !== search.opening) {
        opening = search.opening;
        settled = load(locale).then(
          (catalog) => {
            setTags(catalog.tags);
          },
          () => {
            failed = true;
          },
        );
      }
      return failed || search.scope !== undefined || !query.trim() ? Promise.resolve() : settled;
    },
  };
}
