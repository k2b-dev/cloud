import { type CapabilityCatalogClientResult, invokeCapability, listCapabilityCatalog } from "@k2b/cloud/capabilities";
import { type CloudResourceRef, cloudResourceRefAppId, resolveCapabilityResourceReader } from "@k2b/cloud/contracts";
import type { ResourceCardState } from "@k2b/ui";
import { z } from "zod";

type CatalogApp = Extract<CapabilityCatalogClientResult, { ok: true }>["data"]["apps"][number];

/** What a card shows of a shared Cloud element, read with the viewer's own session. */
export type ResourceCardView = {
  state: Exclude<ResourceCardState, "loading">;
  title?: string;
  icon?: string;
  source?: string;
  preview?: string;
  href?: string;
};

const ReaderDataSchema = z.object({
  refs: z
    .array(
      z.object({
        type: z.string(),
        id: z.string(),
        title: z.string().optional(),
        icon: z.string().optional(),
        preview: z.string().optional(),
      }),
    )
    .optional(),
  links: z.array(z.object({ rel: z.string(), href: z.string() })).optional(),
});

/** Cards read at the same time, so a long history does not flood the apps behind its elements. */
const CONCURRENCY = 4;
/** How long a read stands for the element: access and content may change, so a card shown again later reads again. */
const FRESH_MS = 60_000;
/** Elements remembered per page; the oldest is forgotten first. A history shows only what was scrolled through. */
const REMEMBERED = 200;
/** An app that does not answer in time shows as "not available right now" and frees its place for the next card. */
const DEADLINE_MS = 10_000;

export const resourceKey = (ref: CloudResourceRef) => `${ref.type}\u0000${ref.id}`;

/**
 * Reads shared elements for cards, once per element and page: the owning app's reader decides with the viewer's session
 * what they may see. Whatever the reader refuses or cannot answer shows as a card without title, status, or place.
 */
export const createResourceCards = (dependencies = { listCapabilityCatalog, invokeCapability, now: () => Date.now() }) => {
  const views = new Map<string, { at: number; view: Promise<ResourceCardView> }>();
  let catalog: Promise<Map<string, CatalogApp> | null> | undefined;
  let running = 0;
  const waiting: (() => void)[] = [];

  const apps = () => {
    catalog ??= (async () => {
      const found = new Map<string, CatalogApp>();
      let cursor: string | undefined;
      do {
        const page = await dependencies.listCapabilityCatalog({ cursor, limit: 25, signal: AbortSignal.timeout(DEADLINE_MS) });
        if (!page.ok) return null;
        for (const app of page.data.apps) found.set(app.appId, app);
        cursor = page.data.page.hasMore ? page.data.page.nextCursor : undefined;
      } while (cursor);
      return found;
    })();
    return catalog;
  };
  const slot = async () => {
    if (running >= CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
  };
  const release = () => {
    running--;
    waiting.shift()?.();
  };

  const read = async (ref: CloudResourceRef): Promise<ResourceCardView> => {
    const known = await apps();
    // Without the catalog the card cannot tell missing access from an app that is down.
    if (!known) {
      catalog = undefined;
      return { state: "unavailable" };
    }
    const appId = cloudResourceRefAppId(ref);
    const app = known.get(appId);
    const reader = app ? resolveCapabilityResourceReader(app.manifest, ref) : null;
    if (!app || !reader) return { state: "no_access" };
    await slot();
    try {
      const result = await dependencies.invokeCapability({
        appId,
        capabilityId: reader.localId,
        kind: "query",
        input: { id: ref.id },
        signal: AbortSignal.timeout(DEADLINE_MS),
      });
      if (!result.ok) return { state: result.error.status >= 500 ? "unavailable" : "no_access" };
      const data = ReaderDataSchema.safeParse(result.data);
      const href = data.success ? data.data.links?.find((link) => link.rel === "open")?.href : undefined;
      if (!data.success || !href) return { state: "no_access" };
      const current = data.data.refs?.find((candidate) => candidate.type === ref.type && candidate.id === ref.id);
      const type = app.manifest.types.find((candidate) => `${appId}.${candidate.localId}` === ref.type);
      return {
        state: "ok",
        title: current?.title,
        icon: current?.icon ?? type?.icon,
        // Type titles in manifests are not translated; the app's name is.
        source: app.appName,
        preview: current?.preview,
        href,
      };
    } finally {
      release();
    }
  };

  return {
    /** The card for one element; cards of the same element share one fresh request. */
    view(ref: CloudResourceRef): Promise<ResourceCardView> {
      const key = resourceKey(ref);
      const known = views.get(key);
      if (known && dependencies.now() - known.at < FRESH_MS) return known.view;
      const view = read(ref).catch(() => ({ state: "unavailable" as const }));
      views.delete(key);
      views.set(key, { at: dependencies.now(), view });
      while (views.size > REMEMBERED) views.delete(views.keys().next().value!);
      // An element that could not be read is asked again next time it shows.
      void view.then((result) => {
        if (result.state === "unavailable" && views.get(key)?.view === view) views.delete(key);
      });
      return view;
    },
  };
};
