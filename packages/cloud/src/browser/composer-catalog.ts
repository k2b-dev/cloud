import type { ChatCommandSearch } from "@k2b/ui";
import { createSignal } from "solid-js";
import { listCapabilityCatalog } from "../capabilities/client";
import { LOCALE_HEADER } from "../shared/locale";
import { discoverableCommandInput } from "./discoverable-command";
import { navigationApps } from "./navigation-apps";

export type CloudSearchTag = {
  appId: string;
  appName: string;
  appIcon: string;
  tag: string;
  title: string;
  description: string;
  aliases: readonly string[];
};

export type CloudComposerCommand = {
  id: string;
  appId: string;
  appName: string;
  appIcon: string;
  title: string;
  description: string;
  icon: string;
  keywords: readonly string[];
  input: unknown;
};

/**
 * What composers read from the page's one Capability catalog load. It leaves out the tags of apps without a resource
 * reader: a picker that requires one can show none of their results. A composer that reads such a type itself adds its
 * tag on its own and names the type in `cloudInsertMenu`'s `ownReaders`.
 */
export type CloudComposerCatalog = { tags: readonly CloudSearchTag[]; commands: readonly CloudComposerCommand[] };
export type CloudComposerCatalogState = "loading" | "ready" | "failed";

/** The budget of one Capability query (and of resolving a Command), applied to each catalog page. */
const CATALOG_PAGE_TIMEOUT_MS = 15_000;

const catalogs = new Map<string, Promise<CloudComposerCatalog>>();

const loadCatalog = async (locale: string): Promise<CloudComposerCatalog> => {
  const tags: CloudSearchTag[] = [];
  const commands: CloudComposerCommand[] = [];
  const { appIds, currentAppId } = navigationApps();
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
      if (app.appId !== currentAppId) {
        for (const command of app.manifest.commands) {
          const input = discoverableCommandInput(command, app.appId, appIds);
          if (!input?.success) continue;
          commands.push({
            id: `${app.appId}.${command.localId}`,
            appId: app.appId,
            appName: app.appName,
            appIcon: app.appIcon,
            title: command.title,
            description: command.description,
            icon: command.icon ?? app.appIcon,
            keywords: command.keywords,
            input: input.data,
          });
        }
      }
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
  return { tags, commands };
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
 * The search tags, Commands, and load state of one composer. Call `ready` at the start of every `searchCommands` run: each menu opening starts
 * the shared load once, so only the first opening, or one after a failure, sends a request, and no keystroke does.
 * A search with typed text and no scope waits for that answer, so "/notiz" never settles as "nothing found" before its
 * tag arrives. The overview and scoped searches do not wait, and after a failed load no search waits again; a later
 * success still brings the tags in. A failure keeps the tags the composer had.
 */
export function createCloudComposerCatalog(load: (locale: string) => Promise<CloudComposerCatalog> = loadCloudComposerCatalog) {
  const [tags, setTags] = createSignal<readonly CloudSearchTag[]>([]);
  const [commands, setCommands] = createSignal<readonly CloudComposerCommand[]>([]);
  const [state, setState] = createSignal<CloudComposerCatalogState>("loading");
  let opening: number | undefined;
  let settled: Promise<void> = Promise.resolve();
  let failed = false;
  return {
    tags,
    commands,
    state,
    ready(query: string, search: ChatCommandSearch, locale: string): Promise<void> {
      if (opening !== search.opening) {
        opening = search.opening;
        if (state() === "failed") setState("loading");
        settled = load(locale).then(
          (catalog) => {
            setTags(catalog.tags);
            setCommands(catalog.commands);
            setState("ready");
          },
          () => {
            failed = true;
            setState("failed");
          },
        );
      }
      return failed || search.scope !== undefined || !query.trim() ? Promise.resolve() : settled;
    },
  };
}
