import { type CapabilityCatalogClientResult, invokeCapability, listCapabilityCatalog } from "@k2b/cloud/capabilities";
import { type CloudResourceRef, cloudResourceRefAppId, resolveCapabilityResourceReader } from "@k2b/cloud/contracts";
import type { ResourceCardState } from "@k2b/ui";
import { createSignal } from "solid-js";
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

/**
 * Cards read at the same time, so a long history does not flood the apps behind its elements. The rest wait in order;
 * only shown cards wait, because the history mounts only what is in view and a card that leaves gives up its read.
 */
const CONCURRENCY = 4;
/** How long a read stands for the element: access and content may change, so shown cards read again after it. */
export const FRESH_MS = 60_000;
/** Answered elements remembered per page; the oldest is forgotten first. Elements still being read stay. */
const REMEMBERED = 200;
/** From asking to answer, waiting included; an app that takes longer shows as "not available right now". */
const DEADLINE_MS = 10_000;

const unavailable: ResourceCardView = { state: "unavailable" };

export const resourceKey = (ref: CloudResourceRef) => `${ref.type}\u0000${ref.id}`;

type Entry = { at: number; view: Promise<ResourceCardView>; settled: boolean; users: number; abort: AbortController };

/**
 * Reads shared elements for cards: the owning app's reader decides with the viewer's session what they may see. Each
 * element is read once while fresh and by its cards together; a card that goes away stops a read nobody else waits
 * for. The shown cards read again after a minute, so lost or new access shows without a reload.
 */
export const createResourceCards = (
  dependencies = {
    listCapabilityCatalog,
    invokeCapability,
    now: () => Date.now(),
    timeout: (ms: number): AbortSignal => AbortSignal.timeout(ms),
  },
) => {
  const entries = new Map<string, Entry>();
  let catalog: Promise<Map<string, CatalogApp> | null> | undefined;
  let running = 0;
  const waiting: { entry: Entry; start: () => void }[] = [];
  // Elements whose last read ran out of time while waiting; they go first next time, so no card waits forever.
  const starved = new Set<string>();
  // Shown cards read again when this changes; the page advances it once a minute while it is visible.
  const [epoch, setEpoch] = createSignal(0);

  const apps = () => {
    catalog ??= (async () => {
      const found = new Map<string, CatalogApp>();
      // One deadline for every page: the catalog is read once per page view and shared by all cards.
      const signal = dependencies.timeout(DEADLINE_MS);
      let cursor: string | undefined;
      do {
        const page = await dependencies.listCapabilityCatalog({ cursor, limit: 25, signal });
        if (!page.ok) return null;
        for (const app of page.data.apps) found.set(app.appId, app);
        cursor = page.data.page.hasMore ? page.data.page.nextCursor : undefined;
      } while (cursor);
      return found;
    })();
    return catalog;
  };
  /** Starts waiting reads while places are free, in queue order. */
  const drain = () => {
    while (running < CONCURRENCY && waiting.length > 0) waiting.shift()!.start();
  };
  /**
   * Waits for a place; false when nobody wants the answer any more or its time is up. Every read queues first and the
   * queue drains right after, so an element that ran out of time last round goes before the ones asked with it now.
   */
  const slot = (entry: Entry, key: string) =>
    new Promise<boolean>((resolve) => {
      const signal = entry.abort.signal;
      if (signal.aborted) return resolve(false);
      const cancel = () => {
        const index = waiting.indexOf(waiter);
        if (index >= 0) waiting.splice(index, 1);
        if (entry.users > 0) starved.add(key);
        resolve(false);
      };
      const waiter = {
        entry,
        start: () => {
          signal.removeEventListener("abort", cancel);
          running++;
          resolve(true);
        },
      };
      signal.addEventListener("abort", cancel, { once: true });
      if (starved.delete(key)) waiting.unshift(waiter);
      else waiting.push(waiter);
      queueMicrotask(drain);
    });
  const release = () => {
    running--;
    drain();
  };

  /** The catalog, or null once the card's own time is up or nobody waits for it any more. */
  const appsFor = (entry: Entry) =>
    new Promise<Map<string, CatalogApp> | null | "gone">((resolve) => {
      const signal = entry.abort.signal;
      if (signal.aborted) return resolve("gone");
      const gone = () => resolve("gone");
      signal.addEventListener("abort", gone, { once: true });
      void apps().then((found) => {
        signal.removeEventListener("abort", gone);
        resolve(found);
      });
    });

  const read = async (ref: CloudResourceRef, entry: Entry): Promise<ResourceCardView> => {
    const known = await appsFor(entry);
    if (known === "gone") return unavailable;
    // Without the catalog the card cannot tell missing access from an app that is down.
    if (!known) {
      catalog = undefined;
      return unavailable;
    }
    const appId = cloudResourceRefAppId(ref);
    const app = known.get(appId);
    const reader = app ? resolveCapabilityResourceReader(app.manifest, ref) : null;
    if (!app || !reader) return { state: "no_access" };
    if (!(await slot(entry, resourceKey(ref)))) return unavailable;
    try {
      const result = await dependencies.invokeCapability({
        appId,
        capabilityId: reader.localId,
        kind: "query",
        input: { id: ref.id },
        signal: entry.abort.signal,
      });
      if (!result.ok) return result.error.status >= 500 || result.error.status === 499 ? unavailable : { state: "no_access" };
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
  const forgetOld = () => {
    for (const [key, entry] of entries) {
      if (entries.size <= REMEMBERED) break;
      if (entry.settled && entry.users === 0) entries.delete(key);
    }
  };

  return {
    /** Changes when shown cards should read again. */
    epoch,
    /** Called once a minute while the page is visible. */
    tick: () => {
      // Every answer so far is due again, so each shown card reads once more now.
      for (const entry of entries.values()) if (entry.settled) entry.at = Number.NEGATIVE_INFINITY;
      setEpoch((value) => value + 1);
    },
    /**
     * The card for one element, held by one card until `release`. Cards of the same element share one fresh read; a
     * read nobody holds any more stops.
     */
    view(ref: CloudResourceRef): { view: Promise<ResourceCardView>; release: () => void } {
      const key = resourceKey(ref);
      let entry = entries.get(key);
      if (!entry || (entry.settled && dependencies.now() - entry.at >= FRESH_MS)) {
        const abort = new AbortController();
        dependencies.timeout(DEADLINE_MS).addEventListener("abort", () => abort.abort(), { once: true });
        const next: Entry = { at: dependencies.now(), view: Promise.resolve(unavailable), settled: false, users: 0, abort };
        next.view = read(ref, next)
          .catch(() => unavailable)
          .then((view) => {
            next.settled = true;
            next.at = dependencies.now();
            forgetOld();
            // An element that could not be read is asked again next time it shows.
            if (view.state === "unavailable" && entries.get(key) === next) entries.delete(key);
            return view;
          });
        entries.delete(key);
        entries.set(key, next);
        forgetOld();
        entry = next;
      }
      const held = entry;
      held.users++;
      let released = false;
      return {
        view: held.view,
        release: () => {
          if (released) return;
          released = true;
          held.users--;
          if (held.users > 0) return;
          if (held.settled) {
            forgetOld();
            return;
          }
          held.abort.abort();
          if (entries.get(key) === held) entries.delete(key);
        },
      };
    },
  };
};
