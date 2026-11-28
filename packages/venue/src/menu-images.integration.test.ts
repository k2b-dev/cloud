import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { sql, storage } from "@k2b/cloud";
import type { CloudRuntime } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { settings } from "@k2b/cloud/services";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { remove } from "@k2b/cloud/services/settings";
import { preserveTestSettings, useTestSettings } from "@k2b/cloud/services/settings/settings.test-fixture";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../scripts/fixtures/caller-address";
import { tinyJpeg, withCameraMetadata } from "../../../scripts/fixtures/image-metadata";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import "../../../scripts/fixtures/authorization-preload";
import apiRoutes from "./api";
import type { PublicSection, VenueDashboard } from "./contracts";
import { venueMessages } from "./messages";
import { menuImageCleanup } from "./service/menu-images";

setDefaultTimeout(60_000);

const venueApp = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>()
  .use("*", async (c, next) => {
    c.set("runtime", { apps: [] });
    await next();
  })
  .route("/api/venue", apiRoutes);

type Caller = { cookie: string; "x-cloud-locale"?: string };

const send = (method: "GET" | "POST" | "PATCH" | "DELETE", path: string, caller: Caller, body?: unknown) =>
  venueApp.request(path, {
    method,
    headers: {
      ...caller,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "x-forwarded-for": uniqueCallerAddress(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const json = async <T>(response: Response, status: number, label: string): Promise<T> => {
  const text = await response.text();
  expect({ label, status: response.status, body: response.status === status ? "" : text.slice(0, 2_000) }).toEqual({
    label,
    status,
    body: "",
  });
  return JSON.parse(text) as T;
};

/** A valid 1 × 1 px PNG, as an invented menu photo. */
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const pngDataUrl = `data:image/png;base64,${PNG_BASE64}`;

const insertUser = async (label: string): Promise<string> => {
  const suffix = crypto.randomUUID();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail)
    VALUES (${`venue-${label}-${suffix}`}, 'local', 'user', ${`Venue ${label}`}, ${`venue-${label}-${suffix}@example.test`})
    RETURNING id
  `;
  return row!.id;
};

/** Removes the Venues the user administers, then the user. */
const cleanUp = async (ownerId: string) => {
  const owned = await sql<{ id: string }[]>`
    SELECT va.venue_id::text AS id FROM venue.venue_access va JOIN auth.access a ON a.id = va.access_id WHERE a.user_id = ${ownerId}::uuid
  `;
  for (const { id } of owned) await sql`DELETE FROM venue.venues WHERE id = ${id}::uuid`;
  await sql`DELETE FROM auth.users WHERE id = ${ownerId}::uuid`;
};

const createAdmin = async () => {
  const adminId = await insertUser("admin");
  return { adminId, admin: { cookie: `session_token=${await createTestSession(adminId)}` } };
};

const createVenue = async (admin: Caller, adminId: string, name: string) =>
  (
    await json<{ id: string }>(
      await send("POST", "/api/venue/venues", admin, {
        name,
        slug: `${name.toLowerCase().replaceAll(" ", "-")}-${adminId.slice(0, 8)}`,
        publicEnabled: true,
      }),
      201,
      `create ${name}`,
    )
  ).id;

const items = (section: PublicSection) => section.content.items as Array<{ name: string; image?: string | null }>;

suiteFor(
  "s3",
  "database",
  "nats",
  "valkey",
)("Venue menu images in the object store", () => {
  const venues: string[] = [];
  // Registered before the settings, so it runs while the object store is still configured.
  afterAll(async () => {
    // Objects a failed test left behind; the Venue rows go with the test users.
    for (const venue of venues) {
      for (const key of await objects(venue)) await storage.public.file(key).delete();
    }
  });
  useTestSettings({
    "storage.endpoint": process.env.CLOUD_TEST_S3_ENDPOINT,
    "storage.region": process.env.CLOUD_TEST_S3_REGION,
    "storage.bucket": process.env.CLOUD_TEST_S3_BUCKET,
    "storage.access_key_id": process.env.CLOUD_TEST_S3_ACCESS_KEY_ID,
    "storage.secret_access_key": process.env.CLOUD_TEST_S3_SECRET_ACCESS_KEY,
    "storage.max_object_bytes": 32 * 1024 ** 2,
    "app.url": "https://cloud.example.test",
  });
  beforeAll(async () => {
    await settings.set("security.rate_limit_per_second", 1000);
  });

  const trackedVenue = async (admin: Caller, adminId: string, name: string) => {
    const id = await createVenue(admin, adminId, name);
    venues.push(id);
    return id;
  };

  /** The objects below a Venue's image prefix. */
  const objects = async (venue: string) =>
    ((await storage.public.list({ prefix: `menu/${venue}/` })).contents ?? []).map((object) => object.key).sort();
  /** The object key behind a stored image address. */
  const keyOf = (image: string | null | undefined) => {
    const path = decodeURIComponent(new URL(image ?? "").pathname);
    return path.slice(path.indexOf("/menu/") + 1);
  };

  test("a saved image becomes an object and an address; a removed, replaced, or deleted one goes with its change", async () => {
    const { adminId, admin } = await createAdmin();
    try {
      const cafe = await trackedVenue(admin, adminId, "Harbor Cafe");
      const created = await json<PublicSection>(
        await send("POST", `/api/venue/venues/${cafe}/sections`, admin, {
          kind: "menu",
          title: "Lunch",
          content: {
            items: [
              { name: "Soup", image: pngDataUrl },
              { name: "Stew", image: pngDataUrl },
            ],
          },
        }),
        201,
        "create menu",
      );
      // The same data twice is one object; the section keeps only its permanent address.
      const [soup, stew] = items(created);
      expect(soup?.image).toStartWith(`https://cloud.example.test/public/storage/`);
      expect(soup?.image).toBe(stew?.image);
      const soupKey = keyOf(soup?.image);
      expect(soupKey).toMatch(new RegExp(`^menu/${cafe}/[0-9a-f]{32}\\.png$`));
      expect(await objects(cafe)).toEqual([soupKey]);
      expect(Buffer.from(await storage.public.file(soupKey).bytes()).toString("base64")).toBe(PNG_BASE64);
      const dashboard = await json<VenueDashboard>(await send("GET", `/api/venue/venues/${cafe}/dashboard`, admin), 200, "dashboard");
      expect(JSON.stringify(dashboard.sections)).not.toContain("data:image");

      // A copy shares the address; removing the image from one item keeps it while another still shows it.
      const copy = await json<PublicSection>(
        await send("POST", `/api/venue/venues/${cafe}/sections`, admin, {
          kind: "menu",
          title: "Lunch (copy)",
          content: created.content,
          enabled: false,
        }),
        201,
        "copy menu",
      );
      await json(
        await send("PATCH", `/api/venue/venues/${cafe}/sections/${created.id}`, admin, { content: { items: [{ name: "Soup" }] } }),
        200,
        "remove images from the original",
      );
      await menuImageCleanup.reconcile();
      expect(await objects(cafe)).toEqual([soupKey]);

      // Replacing the copy's image writes a new object and deletes the old one once the change commits.
      const replaced = await json<PublicSection>(
        await send("PATCH", `/api/venue/venues/${cafe}/sections/${copy.id}`, admin, {
          content: {
            items: [
              { name: "Soup", image: `data:image/png;base64,${PNG_BASE64}` },
              { name: "Stew", image: stew?.image },
            ],
          },
        }),
        200,
        "replace an image",
      );
      // The second item still shows the old object, so it stays.
      const replacedKey = keyOf(items(replaced)[0]?.image);
      expect(replacedKey).not.toBe(soupKey);
      await menuImageCleanup.reconcile();
      expect(await objects(cafe)).toEqual([replacedKey, soupKey].sort());

      // Removing an item deletes its object; deleting the section deletes the rest.
      await json(
        await send("PATCH", `/api/venue/venues/${cafe}/sections/${copy.id}`, admin, { content: { items: [items(replaced)[0]] } }),
        200,
        "remove an item",
      );
      await menuImageCleanup.reconcile();
      expect(await objects(cafe)).toEqual([replacedKey]);
      expect((await send("DELETE", `/api/venue/venues/${cafe}/sections/${copy.id}`, admin)).status).toBe(200);
      await menuImageCleanup.reconcile();
      expect(await objects(cafe)).toEqual([]);
    } finally {
      await cleanUp(adminId);
      await menuImageCleanup.reconcile();
    }
  });

  test("deleting a venue deletes every object below its prefix", async () => {
    const { adminId, admin } = await createAdmin();
    try {
      const bakery = await trackedVenue(admin, adminId, "Dockside Bakery");
      await json(
        await send("POST", `/api/venue/venues/${bakery}/sections`, admin, {
          kind: "menu",
          title: "Bread",
          content: { items: [{ name: "Rye", image: pngDataUrl }] },
        }),
        201,
        "create menu",
      );
      // An object no section names any more, such as one left by a process that stopped mid-save.
      const stray = `menu/${bakery}/${"0".repeat(32)}.webp`;
      await storage.public.file(stray).write(new Blob(["stray"], { type: "image/webp" }));
      expect(await objects(bakery)).toHaveLength(2);

      await json(await send("DELETE", `/api/venue/venues/${bakery}`, admin), 200, "delete venue");
      await menuImageCleanup.reconcile();
      expect(await objects(bakery)).toEqual([]);
    } finally {
      await cleanUp(adminId);
    }
  });

  test("a save converts image data stored before images moved, also when the change is elsewhere", async () => {
    const { adminId, admin } = await createAdmin();
    try {
      const cafe = await trackedVenue(admin, adminId, "Corner Cafe");
      const menu = await json<PublicSection>(
        await send("POST", `/api/venue/venues/${cafe}/sections`, admin, {
          kind: "menu",
          title: "Cakes",
          content: { items: [{ name: "Apple pie" }, { name: "Cheesecake" }] },
        }),
        201,
        "create menu",
      );
      // A section saved before images moved: its data stays in the row, and reading never converts it.
      await sql`
        UPDATE venue.public_sections
        SET content = ${JSON.stringify({ items: [{ name: "Apple pie" }, { name: "Cheesecake", image: pngDataUrl }] })}::text::jsonb
        WHERE short_id = ${menu.id}
      `;
      const read = await json<VenueDashboard>(await send("GET", `/api/venue/venues/${cafe}/dashboard`, admin), 200, "dashboard");
      expect(items(read.sections[0]!)[1]?.image).toBe(pngDataUrl);
      expect(await objects(cafe)).toEqual([]);

      // Changing the other item sends the stored data back unchanged; the save moves it to the object store.
      const saved = await json<PublicSection>(
        await send("PATCH", `/api/venue/venues/${cafe}/sections/${menu.id}`, admin, {
          content: { items: [{ name: "Apple pie, warm" }, { name: "Cheesecake", image: pngDataUrl }] },
        }),
        200,
        "edit the other item",
      );
      const converted = items(saved)[1]?.image;
      expect(converted).toStartWith("https://cloud.example.test/public/storage/");
      expect(await objects(cafe)).toEqual([keyOf(converted)]);
    } finally {
      await cleanUp(adminId);
      await menuImageCleanup.reconcile();
    }
  });

  test("a stored image object loses its location and device metadata", async () => {
    const { adminId, admin } = await createAdmin();
    try {
      const cafe = await trackedVenue(admin, adminId, "Dune Cafe");
      const jpeg = await tinyJpeg();
      const camera = `data:image/jpeg;base64,${Buffer.from(withCameraMetadata(jpeg, 1)).toString("base64")}`;
      const created = await json<PublicSection>(
        await send("POST", `/api/venue/venues/${cafe}/sections`, admin, {
          kind: "menu",
          title: "Lunch",
          content: { items: [{ name: "Soup", image: camera }] },
        }),
        201,
        "create menu",
      );
      const key = keyOf(items(created)[0]?.image);
      expect(key).toEndWith(".jpg");
      expect(Buffer.from(await storage.public.file(key).bytes()).equals(Buffer.from(jpeg))).toBe(true);
    } finally {
      await cleanUp(adminId);
    }
  });

  test("only this venue's own image addresses are new; another address stays on an unchanged item until it changes", async () => {
    const { adminId, admin } = await createAdmin();
    try {
      const cafe = await trackedVenue(admin, adminId, "Wharf Cafe");
      const external = "https://images.example.org/menu/soup.webp";
      const refused = await send(
        "POST",
        `/api/venue/venues/${cafe}/sections`,
        { ...admin, "x-cloud-locale": "de" },
        {
          kind: "menu",
          title: "Lunch",
          content: { items: [{ name: "Soup", image: external }] },
        },
      );
      expect({ status: refused.status, body: await refused.json() }).toEqual({
        status: 422,
        body: { code: "MENU_IMAGE_INVALID", message: venueMessages.resolve(["de"]).t.menuImageExternal({ position: 1 }) },
      });
      expect(await objects(cafe)).toEqual([]);

      // A section saved before the rule shows its address to visitors.
      const menu = await json<PublicSection>(
        await send("POST", `/api/venue/venues/${cafe}/sections`, admin, {
          kind: "menu",
          title: "Lunch",
          content: { items: [{ name: "Soup" }, { name: "Stew" }] },
        }),
        201,
        "create menu",
      );
      await sql`
        UPDATE venue.public_sections
        SET content = ${JSON.stringify({ items: [{ name: "Soup", image: external, allergens: "Celery" }, { name: "Stew" }] })}::text::jsonb
        WHERE short_id = ${menu.id}
      `;
      const status = await json<{ sections: PublicSection[] }>(await send("GET", `/api/venue/public/${cafe}/status`, admin), 200, "status");
      expect(items(status.sections[0]!)[0]?.image).toBe(external);

      // It keeps saving while its item stays unchanged: a visibility change, and an edit of the other item in the
      // form the editor sends, with empty fields filled in and the older allergens field as info.
      await json(await send("PATCH", `/api/venue/venues/${cafe}/sections/${menu.id}`, admin, { enabled: false }), 200, "hide");
      const editorItem = (name: string, image: string | null) => ({
        name,
        description: "",
        info: name === "Soup" ? "Celery" : "",
        price: "",
        image,
        availableFrom: null,
        availableUntil: null,
      });
      const edited = await json<PublicSection>(
        await send("PATCH", `/api/venue/venues/${cafe}/sections/${menu.id}`, admin, {
          content: { items: [editorItem("Soup", external), editorItem("Stew, spicy", null)] },
        }),
        200,
        "edit the other item",
      );
      expect(items(edited)[0]?.image).toBe(external);

      // Once its own item changes, the address must give way to an upload: refused, then converted.
      const changed = await send("PATCH", `/api/venue/venues/${cafe}/sections/${menu.id}`, admin, {
        content: { items: [editorItem("Tomato soup", external), editorItem("Stew, spicy", null)] },
      });
      expect({ status: changed.status, code: ((await changed.json()) as { code?: string }).code }).toEqual({
        status: 422,
        code: "MENU_IMAGE_INVALID",
      });
      const uploaded = await json<PublicSection>(
        await send("PATCH", `/api/venue/venues/${cafe}/sections/${menu.id}`, admin, {
          content: { items: [editorItem("Tomato soup", pngDataUrl), editorItem("Stew, spicy", null)] },
        }),
        200,
        "upload again",
      );
      const address = items(uploaded)[0]?.image;
      expect(address).toStartWith("https://cloud.example.test/public/storage/");
      expect(await objects(cafe)).toEqual([keyOf(address)]);
    } finally {
      await cleanUp(adminId);
      await menuImageCleanup.reconcile();
    }
  });

  test("an image past the byte limit or of another type is refused and stores nothing", async () => {
    const { adminId, admin } = await createAdmin();
    try {
      const cafe = await trackedVenue(admin, adminId, "Pier Cafe");
      const big = `data:image/png;base64,${"A".repeat(400 * 1024)}`;
      const refused = await send("POST", `/api/venue/venues/${cafe}/sections`, admin, {
        kind: "menu",
        title: "Lunch",
        content: { items: [{ name: "Soup", image: big }] },
      });
      expect({ status: refused.status, code: ((await refused.json()) as { code?: string }).code }).toEqual({
        status: 422,
        code: "MENU_IMAGE_INVALID",
      });
      const svg = await send("POST", `/api/venue/venues/${cafe}/sections`, admin, {
        kind: "menu",
        title: "Lunch",
        content: { items: [{ name: "Soup", image: "data:image/svg+xml;base64,PHN2Zy8+" }] },
      });
      expect(svg.status).toBe(422);
      expect(await objects(cafe)).toEqual([]);
    } finally {
      await cleanUp(adminId);
    }
  });
});

suiteFor(
  "database",
  "nats",
  "valkey",
)("Venue menu images without an object store", () => {
  preserveTestSettings(["storage.endpoint"]);
  beforeAll(async () => {
    await settings.set("security.rate_limit_per_second", 1000);
    await remove("storage.endpoint");
  });

  test("a new image answers storage_not_configured in the caller's language; older data and everything else keep working", async () => {
    const { adminId, admin } = await createAdmin();
    try {
      const cafe = await createVenue(admin, adminId, "Quay Cafe");
      const refused = await send(
        "POST",
        `/api/venue/venues/${cafe}/sections`,
        { ...admin, "x-cloud-locale": "de" },
        {
          kind: "menu",
          title: "Lunch",
          content: { items: [{ name: "Soup", image: pngDataUrl }] },
        },
      );
      expect({ status: refused.status, body: await refused.json() }).toEqual({
        status: 503,
        body: { code: "storage_not_configured", message: venueMessages.resolve(["de"]).t.menuImageStorageMissing },
      });
      const [stored] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM venue.public_sections s JOIN venue.venues v ON v.id = s.venue_id WHERE v.short_id = ${cafe}
      `;
      expect(stored?.count).toBe(0);

      // A menu without new images saves, and older image data keeps working on every later save.
      const menu = await json<PublicSection>(
        await send("POST", `/api/venue/venues/${cafe}/sections`, admin, {
          kind: "menu",
          title: "Lunch",
          content: { items: [{ name: "Soup" }] },
        }),
        201,
        "menu without an image",
      );
      await sql`
        UPDATE venue.public_sections SET content = ${JSON.stringify({ items: [{ name: "Soup", image: pngDataUrl }] })}::text::jsonb
        WHERE short_id = ${menu.id}
      `;
      const hidden = await json<PublicSection>(
        await send("PATCH", `/api/venue/venues/${cafe}/sections/${menu.id}`, admin, { enabled: false }),
        200,
        "hide the menu",
      );
      expect(items(hidden)[0]?.image).toBe(pngDataUrl);
    } finally {
      await cleanUp(adminId);
    }
  });
});

afterAll(async () => {
  await menuImageCleanup.stop();
});
