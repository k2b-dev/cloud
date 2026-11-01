import { getCapabilityCatalogApp, invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities/server";
import { CloudResourceReaderViewSchema, cloudResourceRefAppId, resolveCapabilityResourceReader } from "@k2b/cloud/contracts";
import type { RequestAuthority } from "@k2b/cloud/server";
import { z } from "zod";
import type { SpaceActivityEvent, SpaceActivityOrigin } from "./activity";

/** What the viewer sees of the work behind a change. Spaces knows only the public reader contract, never its owner. */
export type SpaceActivityOriginView = {
  /** The reader's live title, or the type and owner as they were when the change happened. */
  name: string | null;
  typeTitle: string | null;
  owner: string | null;
  /** The named part of that work, such as one automation. */
  detail: string | null;
  href: string | null;
  runHref: string | null;
  /** The account that acted no longer exists. */
  deleted: boolean;
};

const OriginSchema = z.object({ type: z.string().min(1).max(200), id: z.string().min(1).max(200), owner: z.string().max(200).optional() });
const ReaderSchema = z.object({ view: CloudResourceReaderViewSchema });
const ORIGIN_READERS = 10;
const ORIGIN_READ_MS = 1_500;

export const activityOrigin = (event: Pick<SpaceActivityEvent, "metadata">): SpaceActivityOrigin | null => {
  const parsed = OriginSchema.safeParse(event.metadata.origin);
  return parsed.success ? parsed.data : null;
};

/**
 * Ask each origin's owning app about it, under the viewer's own authority. One page names few origins, so the reads are
 * bounded and share one short budget; a slow or refusing reader only leaves the link and the live title out.
 */
export const presentActivityOrigins = async (
  events: readonly SpaceActivityEvent[],
  authority: RequestAuthority | null,
  locale: string,
): Promise<Map<string, SpaceActivityOriginView>> => {
  const refs = new Map<string, SpaceActivityOrigin>();
  for (const event of events) {
    const origin = activityOrigin(event);
    if (origin) refs.set(`${origin.type}|${origin.id}`, origin);
  }
  const signal = AbortSignal.timeout(ORIGIN_READ_MS);
  const views = new Map<string, Omit<SpaceActivityOriginView, "deleted">>();
  await Promise.all(
    [...refs].slice(0, ORIGIN_READERS).map(async ([key, origin]) => {
      const view: Omit<SpaceActivityOriginView, "deleted"> = {
        name: null,
        typeTitle: null,
        owner: origin.owner ?? null,
        detail: null,
        href: null,
        runHref: null,
      };
      views.set(key, view);
      if (!authority) return;
      try {
        const ref = { type: origin.type, id: origin.id };
        const appId = cloudResourceRefAppId(ref);
        const catalog = await getCapabilityCatalogApp(appId, locale, authority);
        const manifest = catalog.ok ? catalog.data?.manifest : null;
        if (!manifest) return;
        view.typeTitle = manifest.types?.find((type) => `${appId}.${type.localId}` === origin.type)?.title ?? null;
        const reader = resolveCapabilityResourceReader(manifest, ref);
        if (!reader) return;
        const read = await invokeCapabilityWithDataSchema(
          { appId, capabilityId: reader.localId, kind: "query", input: { id: origin.id } },
          ReaderSchema,
          { authority, locale, signal },
        );
        if (!read.ok) return;
        view.name = read.data.data.view.title;
        view.detail = read.data.data.view.context ?? null;
        view.href = read.data.links?.find((link) => link.rel === "open")?.href ?? null;
        view.runHref = read.data.links?.find((link) => link.rel === "status")?.href ?? null;
      } catch {
        // The row keeps what it knew when the change happened.
      }
    }),
  );
  const result = new Map<string, SpaceActivityOriginView>();
  for (const event of events) {
    const origin = activityOrigin(event);
    const view = origin ? views.get(`${origin.type}|${origin.id}`) : undefined;
    if (origin)
      result.set(event.id, {
        ...(view ?? { name: null, typeTitle: null, owner: origin.owner ?? null, detail: null, href: null, runHref: null }),
        deleted: event.actor.kind === "service_account" && event.actor.displayName === "Former service account",
      });
  }
  return result;
};
