import { beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { CloudRuntime } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { settings } from "@k2b/cloud/services";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../scripts/fixtures/test-short-id";
import "../../../scripts/fixtures/authorization-preload";
import apiRoutes from "./api";
import {
  MAX_PUBLIC_MENU_ITEMS,
  MAX_PUBLIC_SECTIONS,
  MENU_ITEM_LIMIT,
  PUBLIC_PAGE_HTML_BUDGET_BYTES,
  PUBLIC_SECTION_LIMIT,
  type PublicStatus,
  type VenueDashboard,
} from "./contracts";
import { venueMessages } from "./messages";
import "./frontend/ssr-test-plugin";

const { default: pageRoutes } = await import("./frontend");

const suite = suiteFor("database", "nats", "valkey");
setDefaultTimeout(60_000);

const venueApp = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>()
  .use("*", async (c, next) => {
    c.set("runtime", { apps: [] });
    await next();
  })
  .route("/api/venue", apiRoutes)
  .route("/app/venue", pageRoutes);

type Caller = { cookie?: string; "x-cloud-locale"?: string };

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

const expectStatus = async (response: Response, status: number, label: string): Promise<string> => {
  const text = await response.text();
  expect({ label, status: response.status, body: response.status === status ? "" : text.slice(0, 2_000) }).toEqual({
    label,
    status,
    body: "",
  });
  return text;
};

const insertUser = async (label: string): Promise<string> => {
  const suffix = crypto.randomUUID();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail)
    VALUES (${`venue-${label}-${suffix}`}, 'local', 'user', ${`Venue ${label}`}, ${`venue-${label}-${suffix}@example.test`})
    RETURNING id
  `;
  return row!.id;
};

/** A full menu item as a café writes one: a long name, a description, allergens, a price, and an image address. */
const menuItem = (index: number) => ({
  name: `Homemade pumpkin and ginger soup with roasted seeds, number ${index}`,
  description:
    "Slow-cooked Hokkaido pumpkin with fresh ginger, coconut milk and a hint of chili, served with toasted sourdough bread and a swirl of pumpkin seed oil.",
  info: "Contains celery, mustard, and gluten; vegan on request",
  price: "4.50 EUR",
  image: `https://images.example.org/venue/menus/autumn-2026/pumpkin-soup-${index}.webp`,
});
const menuItems = (count: number, from = 0) => Array.from({ length: count }, (_, index) => menuItem(from + index));

/** The largest section kind measured for the page budget: a links section with three links. */
const linksSection = (index: number) => ({
  kind: "links",
  title: `Useful links ${index}`,
  content: {
    links: [
      { label: "Student union", href: "https://union.example.org/cafe" },
      { label: "Write to us", href: "mailto:cafe@example.org" },
      { label: "Feedback form", href: "/app/grids/forms/Form01" },
    ],
  },
});

suite("Venue public page limits", () => {
  beforeAll(async () => {
    await settings.set("security.rate_limit_per_second", 1000);
  });

  test("a venue takes sections and menu items up to its page budget, refuses one more, and its page stays within the budget", async () => {
    const adminId = await insertUser("admin");
    const admin = { cookie: `session_token=${await createTestSession(adminId)}` };
    const german = { ...admin, "x-cloud-locale": "de" };
    const de = venueMessages.resolve(["de"]).t;

    try {
      const created = await send("POST", "/api/venue/venues", admin, {
        name: "Harbor Cafe",
        slug: `harbor-cafe-${adminId.slice(0, 8)}`,
        publicEnabled: true,
      });
      const cafe = (JSON.parse(await expectStatus(created, 201, "create venue")) as { id: string }).id;
      const [venueRow] = await sql<{ id: string }[]>`SELECT id FROM venue.venues WHERE short_id = ${cafe}`;
      const venueId = venueRow!.id;
      const stored = async () => {
        const [row] = await sql<{ sections: number; items: number }[]>`
          SELECT count(*)::int AS sections,
                 coalesce(sum(CASE WHEN kind = 'menu' THEN jsonb_array_length(content->'items') ELSE 0 END), 0)::int AS items
          FROM venue.public_sections WHERE venue_id = ${venueId}::uuid
        `;
        return row!;
      };
      const create = (body: unknown, caller: Caller = admin) => send("POST", `/api/venue/venues/${cafe}/sections`, caller, body);
      const createOk = async (body: unknown, label: string) =>
        (JSON.parse(await expectStatus(await create(body), 201, label)) as { id: string }).id;

      // Up to the limits: two menus holding every menu item between them, the other sections the largest kind.
      const firstHalf = Math.floor(MAX_PUBLIC_MENU_ITEMS / 2);
      const lunch = await createOk({ kind: "menu", title: "Lunch", content: { items: menuItems(firstHalf) } }, "lunch menu");
      await createOk(
        { kind: "menu", title: "Cakes", content: { items: menuItems(MAX_PUBLIC_MENU_ITEMS - firstHalf, firstHalf) } },
        "cake menu",
      );
      const linkIds: string[] = [];
      for (let index = 2; index < MAX_PUBLIC_SECTIONS; index++) linkIds.push(await createOk(linksSection(index), `links ${index}`));
      expect(await stored()).toEqual({ sections: MAX_PUBLIC_SECTIONS, items: MAX_PUBLIC_MENU_ITEMS });

      // The guest page at both limits stays within its HTML budget.
      const html = await expectStatus(await send("GET", `/app/venue/public/${cafe}`, {}), 200, "public page");
      const pageBytes = Buffer.byteLength(html);
      expect({ pageBytes, withinBudget: pageBytes <= PUBLIC_PAGE_HTML_BUDGET_BYTES }).toEqual({ pageBytes, withinBudget: true });

      // One more section is refused with the stable code and the caller's language, and stores nothing.
      const refused = await create({ kind: "notice", title: "One too many", content: { text: "Hello" } }, german);
      expect({ status: refused.status, body: await refused.json() }).toEqual({
        status: 422,
        body: { code: PUBLIC_SECTION_LIMIT, message: de.sectionLimitReached({ max: MAX_PUBLIC_SECTIONS }) },
      });
      expect(await stored()).toEqual({ sections: MAX_PUBLIC_SECTIONS, items: MAX_PUBLIC_MENU_ITEMS });

      // With room for a section, a menu with one more item is still refused, and so is an edit that adds one.
      await expectStatus(await send("DELETE", `/api/venue/venues/${cafe}/sections/${linkIds[0]}`, admin), 200, "delete links");
      const extraMenu = await create({ kind: "menu", title: "Drinks", content: { items: menuItems(1) } });
      expect({ status: extraMenu.status, code: ((await extraMenu.json()) as { code?: string }).code }).toEqual({
        status: 422,
        code: MENU_ITEM_LIMIT,
      });
      const grown = await send("PATCH", `/api/venue/venues/${cafe}/sections/${lunch}`, admin, {
        content: { items: menuItems(firstHalf + 1) },
      });
      expect({ status: grown.status, code: ((await grown.json()) as { code?: string }).code }).toEqual({
        status: 422,
        code: MENU_ITEM_LIMIT,
      });
      expect(await stored()).toEqual({ sections: MAX_PUBLIC_SECTIONS - 1, items: MAX_PUBLIC_MENU_ITEMS });

      // An edit that adds no item saves; a section without items still fits.
      await expectStatus(
        await send("PATCH", `/api/venue/venues/${cafe}/sections/${lunch}`, admin, { title: "Lunch today" }),
        200,
        "rename lunch",
      );
      await createOk({ kind: "notice", title: "Closed on Friday", content: { text: "Team day" } }, "notice fits");

      // Two saves at the same time never pass the limit together: of two sections for the last place, one is stored.
      await expectStatus(await send("DELETE", `/api/venue/venues/${cafe}/sections/${linkIds[1]}`, admin), 200, "delete links");
      const racing = await Promise.all([1, 2].map((index) => create({ kind: "notice", title: `Race ${index}`, content: { text: "Hi" } })));
      expect(racing.map((response) => response.status).sort()).toEqual([201, 422]);
      expect(await stored()).toEqual({ sections: MAX_PUBLIC_SECTIONS, items: MAX_PUBLIC_MENU_ITEMS });
    } finally {
      await cleanUp(adminId);
    }
  });

  test("a page saved before the limits shows admins everything, visitors the first part, and can be edited down", async () => {
    const adminId = await insertUser("admin");
    const admin = { cookie: `session_token=${await createTestSession(adminId)}` };

    try {
      const created = await send("POST", "/api/venue/venues", admin, {
        name: "Dockside Bakery",
        slug: `dockside-bakery-${adminId.slice(0, 8)}`,
        publicEnabled: true,
      });
      const bakery = (JSON.parse(await expectStatus(created, 201, "create venue")) as { id: string }).id;
      const [venueRow] = await sql<{ id: string }[]>`SELECT id FROM venue.venues WHERE short_id = ${bakery}`;
      const venueId = venueRow!.id;
      const menu = (
        JSON.parse(
          await expectStatus(
            await send("POST", `/api/venue/venues/${bakery}/sections`, admin, {
              kind: "menu",
              title: "Bread",
              content: { items: menuItems(2) },
            }),
            201,
            "menu",
          ),
        ) as { id: string }
      ).id;
      // Rows written before the limits existed: more menu items and more sections than a page holds.
      await sql`
        UPDATE venue.public_sections SET content = ${JSON.stringify({ items: menuItems(MAX_PUBLIC_MENU_ITEMS + 5) })}::text::jsonb
        WHERE short_id = ${menu}
      `;
      for (let index = 1; index <= MAX_PUBLIC_SECTIONS; index++) {
        await sql`
          INSERT INTO venue.public_sections (short_id, venue_id, kind, title, content, enabled, position)
          VALUES (${testShortId()}, ${venueId}::uuid, 'notice', ${`Notice ${index}`}, ${JSON.stringify({ text: "Hi" })}::text::jsonb, true, ${index + 1})
        `;
      }

      const dashboard = JSON.parse(
        await expectStatus(await send("GET", `/api/venue/venues/${bakery}/dashboard`, admin), 200, "dashboard"),
      ) as VenueDashboard;
      expect(dashboard.sections).toHaveLength(MAX_PUBLIC_SECTIONS + 1);
      expect(dashboard.sections[0]?.content.items).toHaveLength(MAX_PUBLIC_MENU_ITEMS + 5);

      const status = JSON.parse(
        await expectStatus(await send("GET", `/api/venue/public/${bakery}/status`, {}), 200, "public status"),
      ) as PublicStatus;
      expect(status.sections).toHaveLength(MAX_PUBLIC_SECTIONS);
      expect(status.sections[0]?.content.items).toHaveLength(MAX_PUBLIC_MENU_ITEMS);
      expect(status.sections.at(-1)?.title).toBe(`Notice ${MAX_PUBLIC_SECTIONS - 1}`);

      // Removing items saves although the page stays past its limits; adding one does not.
      await expectStatus(
        await send("PATCH", `/api/venue/venues/${bakery}/sections/${menu}`, admin, {
          content: { items: menuItems(MAX_PUBLIC_MENU_ITEMS + 1) },
        }),
        200,
        "remove items",
      );
      const added = await send("PATCH", `/api/venue/venues/${bakery}/sections/${menu}`, admin, {
        content: { items: menuItems(MAX_PUBLIC_MENU_ITEMS + 2) },
      });
      expect(added.status).toBe(422);
    } finally {
      await cleanUp(adminId);
    }
  });
});

/** Removes the Venues the user administers, then the user. */
const cleanUp = async (ownerId: string) => {
  const owned = await sql<{ id: string }[]>`
    SELECT va.venue_id::text AS id FROM venue.venue_access va JOIN auth.access a ON a.id = va.access_id WHERE a.user_id = ${ownerId}::uuid
  `;
  for (const { id } of owned) await sql`DELETE FROM venue.venues WHERE id = ${id}::uuid`;
  await sql`DELETE FROM auth.users WHERE id = ${ownerId}::uuid`;
};
