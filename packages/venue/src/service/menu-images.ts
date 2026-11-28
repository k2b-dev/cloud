import { sql, storage } from "@k2b/cloud";
import { fail, ok, type Result } from "@k2b/cloud/server";
import { logger } from "@k2b/cloud/services";
import { stripImageDataUrlMetadata } from "@k2b/cloud/services/image-metadata";
import { createPgOutbox, PgOutboxDeferred } from "@k2b/cloud/services/outbox";
import { MAX_MENU_IMAGE_BYTES, MENU_IMAGE_INVALID } from "../contracts";
import { venueMessages } from "../messages";

type SqlClient = typeof sql;

const log = logger("venue:menu-images");

/**
 * Menu images live in the public object store at `menu/<venue short ID>/<random>.<type>`: the random name keeps
 * images of drafts and hidden sections unguessable, and the Venue's prefix lets its deletion remove them all. A
 * section stores only the permanent address. Nothing else is stored under `menu/`.
 */
const IMAGE_TYPES: Record<string, string> = { "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif" };
const DATA_URL = /^data:(image\/(?:webp|png|jpeg|gif));base64,([A-Za-z0-9+/]+={0,2})$/;
const OBJECT_NAME = /^[0-9a-f]{32}\.(?:webp|png|jpg|gif)$/;

export const menuImagePrefix = (venueShortId: string): string => `menu/${venueShortId}/`;

/** Where one Venue's menu images live: their object key prefix and the path their public addresses start with. */
export type MenuImageLocation = { venueShortId: string; prefix: string; path: string };

/** The platform names the address path, so it follows the app's package and never a hand-built URL. */
export const menuImageLocation = async (venueShortId: string): Promise<MenuImageLocation> => {
  const prefix = menuImagePrefix(venueShortId);
  const probe = "probe.webp";
  const path = decodeURIComponent(new URL(await storage.public.file(`${prefix}${probe}`).url).pathname);
  return { venueShortId, prefix, path: path.slice(0, -probe.length) };
};

/**
 * The object key behind `image` when it is an address of this Venue's menu images, otherwise `null`. Only the path
 * counts, so addresses survive a change of the Cloud's origin; another Venue's images are never this Venue's.
 */
export const ownMenuImageKey = (location: MenuImageLocation, image: unknown): string | null => {
  if (typeof image !== "string" || !/^https?:\/\//.test(image)) return null;
  let path: string;
  try {
    path = decodeURIComponent(new URL(image).pathname);
  } catch {
    return null;
  }
  if (!path.startsWith(location.path)) return null;
  const name = path.slice(location.path.length);
  return OBJECT_NAME.test(name) ? `${location.prefix}${name}` : null;
};

const menuItems = (content: Record<string, unknown>): unknown[] => (Array.isArray(content.items) ? content.items : []);
const imageOf = (item: unknown): unknown => (item && typeof item === "object" ? (item as Record<string, unknown>).image : undefined);

/** The object keys a section's items refer to, whatever its kind, so a kind change never orphans or breaks one. */
export const sectionImageKeys = (location: MenuImageLocation, content: Record<string, unknown>): string[] =>
  menuItems(content).flatMap((item) => ownMenuImageKey(location, imageOf(item)) ?? []);

/** The object store reports missing or unusable configuration with a `storage_*` code. */
const storageConfigurationCode = (error: unknown): string | null => {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  return typeof code === "string" && code.startsWith("storage_") ? code : null;
};

type CleanupRow = { id: string; attempts: number; venue_short_id: string; object_key: string; prefix: boolean };

/** Deletes every object below `prefix`, a page at a time; a repeat finds nothing left. */
const deletePrefix = async (prefix: string): Promise<void> => {
  for (;;) {
    const page = await storage.public.list({ prefix, maxKeys: 1000 });
    const keys = page.contents?.map((object) => object.key) ?? [];
    await Promise.all(keys.map((key) => storage.public.file(key).delete()));
    if (keys.length === 0 || !page.isTruncated) return;
  }
};

/**
 * Deletes menu images after the change that dropped them committed. A row commits with that change, so a deletion
 * survives a failed request or process; without an object store the rows wait until one is configured.
 */
export const menuImageCleanup = createPgOutbox<CleanupRow>({
  table: "venue.menu_image_cleanup",
  name: "venue:menu-image-cleanup",
  orderBy: "venue_short_id",
  sequence: "seq",
  reconcileIntervalMs: 60_000,
  publish: async (row) => {
    try {
      if (row.prefix) await deletePrefix(row.object_key);
      else await storage.public.file(row.object_key).delete();
    } catch (error) {
      if (storageConfigurationCode(error)) throw new PgOutboxDeferred("The object store is not configured.");
      throw error;
    }
  },
});

/** Commits deletions of `keys` with the caller's transaction; `prefix` deletes everything below one key prefix. */
export const enqueueMenuImageCleanup = async (
  tx: SqlClient,
  venue: Pick<MenuImageLocation, "venueShortId">,
  keys: readonly string[],
  prefix = false,
): Promise<void> => {
  if (keys.length === 0) return;
  await tx`
    INSERT INTO venue.menu_image_cleanup (venue_short_id, object_key, prefix)
    SELECT ${venue.venueShortId}, key, ${prefix} FROM unnest(${sql.array([...keys], "text")}::text[]) AS key
  `;
};

/** Wakes the cleanup after a commit that enqueued deletions. */
export const notifyMenuImageCleanup = (): void => {
  void menuImageCleanup.notify();
};

/**
 * Object keys a save no longer refers to: `before` minus every image the Venue's sections still name after the
 * change. Another section, such as a copy, may share an image, so only the last reference deletes it.
 */
export const unreferencedMenuImageKeys = async (
  tx: SqlClient,
  venueId: string,
  location: MenuImageLocation,
  before: readonly string[],
): Promise<string[]> => {
  if (before.length === 0) return [];
  const rows = await tx<{ image: string }[]>`
    SELECT DISTINCT item->>'image' AS image
    FROM venue.public_sections s
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(s.content->'items') = 'array' THEN s.content->'items' ELSE '[]'::jsonb END
    ) AS item
    WHERE s.venue_id = ${venueId}::uuid AND item->>'image' LIKE 'http%'
  `;
  const referenced = new Set(rows.flatMap((row) => ownMenuImageKey(location, row.image) ?? []));
  return [...new Set(before)].filter((key) => !referenced.has(key));
};

/** Image strings among `images` that the Venue already stores: older data, which saving converts but never refuses. */
const storedImages = async (venueId: string, images: readonly string[]): Promise<Set<string>> => {
  if (images.length === 0) return new Set();
  const rows = await sql<{ image: string }[]>`
    SELECT DISTINCT item->>'image' AS image
    FROM venue.public_sections s
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(s.content->'items') = 'array' THEN s.content->'items' ELSE '[]'::jsonb END
    ) AS item
    WHERE s.venue_id = ${venueId}::uuid AND item->>'image' = ANY(${sql.array([...images], "text")}::text[])
  `;
  return new Set(rows.map((row) => row.image));
};

const imageFailure = (message: string) => fail({ code: MENU_IMAGE_INVALID, status: 422 as const, message });

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/**
 * What an item shows, in the form the editor sends it back: an item saved again without a change has the same
 * fingerprint, also when the editor fills empty fields or the older `allergens` field became `info`.
 */
const itemFingerprint = (item: unknown): string => {
  const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
  return JSON.stringify([
    text(entry.name),
    text(entry.description),
    text(entry.info) || text(entry.allergens),
    text(entry.price),
    entry.availableFrom || null,
    entry.availableUntil || null,
    entry.image ?? null,
  ]);
};

/** `content` with each image that `addresses` names replaced by its object store address. */
export const withMenuImageAddresses = (
  content: Record<string, unknown>,
  addresses: ReadonlyMap<string, string>,
): Record<string, unknown> =>
  addresses.size === 0 || !Array.isArray(content.items)
    ? content
    : {
        ...content,
        items: content.items.map((item: unknown) => {
          const image = imageOf(item);
          return typeof image === "string" && addresses.has(image) ? { ...(item as object), image: addresses.get(image) } : item;
        }),
      };

/**
 * Moves the image data in a menu's items into the object store and returns, per data string, the object's
 * permanent address to put in its item (see {@link withMenuImageAddresses}). An address of this Venue's own menu
 * images stays as it is. Any other web address stays only on an item saved again unchanged, one with the same
 * fingerprint in `storedItems`; once its item changes, the image has to be uploaded again or removed. Data the
 * Venue already stored, from before images moved, converts too but is never refused: without an object store it
 * stays as it is. New data needs a supported type, at most
 * {@link MAX_MENU_IMAGE_BYTES}, and an object store; a refused save leaves no object behind.
 */
export const storeMenuImages = async (
  venue: { id: string; shortId: string },
  section: { kind: string; content: Record<string, unknown> },
  storedItems: readonly unknown[],
  locale?: string,
): Promise<Result<{ addresses: Map<string, string>; uploaded: string[] }>> => {
  const items = menuItems(section.content);
  const webAddresses = items.flatMap((item, index) => {
    const image = imageOf(item);
    return typeof image === "string" && /^https?:\/\//.test(image) ? [{ item, index }] : [];
  });
  if (webAddresses.length > 0) {
    const location = await menuImageLocation(venue.shortId);
    const unchanged = new Set(storedItems.map(itemFingerprint));
    const foreign = webAddresses.find(({ item }) => !ownMenuImageKey(location, imageOf(item)) && !unchanged.has(itemFingerprint(item)));
    if (foreign) {
      const { t } = venueMessages.resolve(locale ? [locale] : []);
      return imageFailure(t.menuImageExternal({ position: foreign.index + 1 }));
    }
  }
  const candidates = items.flatMap((item) => {
    const image = imageOf(item);
    return typeof image === "string" && !/^https?:\/\//.test(image) ? [image] : [];
  });
  if (candidates.length === 0) return ok({ addresses: new Map(), uploaded: [] });
  const { t } = venueMessages.resolve(locale ? [locale] : []);
  const stored = await storedImages(venue.id, candidates);
  const addresses = new Map<string, string>();
  const uploaded: string[] = [];
  let storageMissing = false;

  const discard = async () => {
    if (uploaded.length === 0) return;
    await enqueueMenuImageCleanup(sql, { venueShortId: venue.shortId }, uploaded);
    notifyMenuImageCleanup();
  };

  try {
    for (const [index, item] of items.entries()) {
      const image = imageOf(item);
      if (typeof image !== "string" || /^https?:\/\//.test(image) || addresses.has(image)) continue;
      const older = stored.has(image);
      const match = DATA_URL.exec(image);
      if (!match) {
        if (older) continue;
        await discard();
        return imageFailure(t.menuImageInvalid({ position: index + 1 }));
      }
      const [, type, data] = match as unknown as [string, string, string];
      const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
      if (!older && (data.length * 3) / 4 - padding > MAX_MENU_IMAGE_BYTES) {
        await discard();
        return imageFailure(t.menuImageTooLarge({ position: index + 1, maxKilobytes: Math.floor(MAX_MENU_IMAGE_BYTES / 1000) }));
      }
      const cleaned = stripImageDataUrlMetadata(image);
      if (storageMissing) {
        addresses.set(image, cleaned);
        continue;
      }
      const key = `${menuImagePrefix(venue.shortId)}${crypto.randomUUID().replaceAll("-", "")}.${IMAGE_TYPES[type]}`;
      const file = storage.public.file(key);
      try {
        await file.write(Buffer.from(cleaned.slice(cleaned.indexOf(",") + 1), "base64"), { type });
      } catch (error) {
        const code = storageConfigurationCode(error);
        if (!code) throw error;
        if (!older) {
          await discard();
          return fail({ code, status: 503 as const, message: t.menuImageStorageMissing });
        }
        // Older data keeps working without an object store; it converts on a save once one is configured.
        storageMissing = true;
        addresses.set(image, cleaned);
        continue;
      }
      uploaded.push(key);
      addresses.set(image, await file.url);
    }
  } catch (error) {
    await discard();
    throw error;
  }

  if (storageMissing) log.warn("Kept older menu image data without an object store", { venueId: venue.id });
  return ok({ addresses, uploaded });
};

/** Commits deletion of objects a failed save had already written. */
export const discardMenuImages = async (venueShortId: string, keys: readonly string[]): Promise<void> => {
  if (keys.length === 0) return;
  await enqueueMenuImageCleanup(sql, { venueShortId }, keys);
  notifyMenuImageCleanup();
};
