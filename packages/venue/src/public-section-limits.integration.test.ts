import { beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { sql, storage } from "@k2b/cloud";
import type { CloudRuntime } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { settings } from "@k2b/cloud/services";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { useTestSettings } from "@k2b/cloud/services/settings/settings.test-fixture";
import { dates } from "@k2b/stdlib";
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
  PUBLIC_EXCEPTION_DAYS,
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

/**
 * Where the current test's Venue keeps its menu images, as the object store addresses them. Saving accepts only
 * such addresses besides image data, and building one needs no object store.
 */
let imageBase = "";
const useVenueImages = async (venue: string) => {
  const probe = `${"0".repeat(32)}.webp`;
  const url = await storage.public.file(`menu/${venue}/${probe}`).url;
  imageBase = url.slice(0, -probe.length);
};

/** A full menu item as a café writes one: a long name, a description, allergens, a price, and an image address. */
const menuItem = (index: number) => ({
  name: `Homemade pumpkin and ginger soup with roasted seeds, number ${index}`,
  description:
    "Slow-cooked Hokkaido pumpkin with fresh ginger, coconut milk and a hint of chili, served with toasted sourdough bread and a swirl of pumpkin seed oil.",
  info: "Contains celery, mustard, and gluten; vegan on request",
  price: "4.50 EUR",
  image: `${imageBase}${index.toString(16).padStart(32, "0")}.webp`,
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

/**
 * Everything the page shows besides its sections, at a stated worst case the 40 kB reserve of the page budget must
 * hold: two opening windows with a note on every weekday, a changed-hours entry with a note on every one of the
 * {@link PUBLIC_EXCEPTION_DAYS} days the page lists (one per date is the most the contract stores), and the eight
 * upcoming openings the public status lists at most. Opening rules have no count limit, so their worst case is a
 * busy café's week rather than a maximum.
 */
const seedEverythingButSections = async (cafe: string, caller: Caller, timeZone: string) => {
  for (let weekday = 0; weekday < 7; weekday++) {
    for (const rule of [
      { startTime: "08:00", endTime: "11:30", note: "Breakfast with fresh pastries from the bakery next door" },
      { startTime: "12:00", endTime: "18:00", note: "The kitchen closes thirty minutes earlier" },
    ]) {
      await expectStatus(await send("POST", `/api/venue/venues/${cafe}/opening-rules`, caller, { weekday, ...rule }), 201, "opening rule");
    }
  }
  for (let offset = 0; offset < PUBLIC_EXCEPTION_DAYS; offset++) {
    const date = dates.formatDateKey(new Date(Date.now() + offset * 86_400_000), { timeZone });
    await expectStatus(
      await send("POST", `/api/venue/venues/${cafe}/overrides`, caller, {
        date,
        kind: "open",
        startTime: "18:00",
        endTime: "23:00",
        note: "Long night of the sciences with live music and longer kitchen hours",
      }),
      201,
      `changed hours ${date}`,
    );
  }
  for (let day = 1; day <= 8; day++) {
    const startsAt = new Date(Date.now() + day * 86_400_000);
    await expectStatus(
      await send("POST", `/api/venue/venues/${cafe}/free-signup`, caller, {
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      }),
      201,
      `opening ${day}`,
    );
  }
};

suite("Venue public page limits", () => {
  useTestSettings({ "app.url": "https://cloud.example.test" });
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
      const { id: cafe, timezone } = JSON.parse(await expectStatus(created, 201, "create venue")) as { id: string; timezone: string };
      await useVenueImages(cafe);
      const [venueRow] = await sql<{ id: string }[]>`SELECT id FROM venue.venues WHERE short_id = ${cafe}`;
      const venueId = venueRow!.id;
      await seedEverythingButSections(cafe, admin, timezone);
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

      // The guest page at both limits, every menu item with an image address and the worst case of everything else,
      // stays within its HTML budget.
      const shown = JSON.parse(
        await expectStatus(await send("GET", `/api/venue/public/${cafe}/status`, {}), 200, "public status"),
      ) as PublicStatus;
      // A run that crosses midnight in the Venue's time zone lists one changed day less.
      expect({
        rules: shown.openingRules.length,
        changedDays: shown.upcomingExceptions.length >= PUBLIC_EXCEPTION_DAYS - 1,
        openings: shown.upcomingOpenings.length,
        sections: shown.sections.length,
      }).toEqual({ rules: 14, changedDays: true, openings: 8, sections: MAX_PUBLIC_SECTIONS });
      const html = await expectStatus(await send("GET", `/app/venue/public/${cafe}`, {}), 200, "public page");
      const pageBytes = Buffer.byteLength(html);
      expect(html).toContain(`<img src="${imageBase}`);
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

      // A save counts only once it holds the Venue lock: while another transaction holds it, a create waits; that
      // transaction takes the last place, and the waiting create then counts it and is refused. Without the lock the
      // create would count the committed sections only and store one past the limit.
      await expectStatus(await send("DELETE", `/api/venue/venues/${cafe}/sections/${linkIds[1]}`, admin), 200, "delete links");
      const createWaitsForLock = async () => {
        const [row] = await sql<{ waiting: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query LIKE '%FROM venue.venues WHERE id = %FOR NO KEY UPDATE%'
          ) AS waiting
        `;
        return row!.waiting;
      };
      let waiting: Promise<Response> | undefined;
      let answered = false;
      await sql.begin(async (tx) => {
        await tx`SELECT 1 FROM venue.venues WHERE id = ${venueId}::uuid FOR NO KEY UPDATE`;
        const pending = Promise.resolve(create({ kind: "notice", title: "Waits for the lock", content: { text: "Hi" } }));
        waiting = pending;
        const markAnswered = () => {
          answered = true;
        };
        pending.then(markAnswered, markAnswered);
        // Bounded by the test's timeout. A create that answers without waiting fails the assertions below.
        while (!answered && !(await createWaitsForLock())) await Bun.sleep(10);
        await tx`
          INSERT INTO venue.public_sections (short_id, venue_id, kind, title, content, enabled, position)
          VALUES (${testShortId()}, ${venueId}::uuid, 'notice', 'Last place', ${JSON.stringify({ text: "Hi" })}::text::jsonb, true, 99)
        `;
      });
      const late = await waiting!;
      expect({ status: late.status, code: ((await late.json()) as { code?: string }).code }).toEqual({
        status: 422,
        code: PUBLIC_SECTION_LIMIT,
      });
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
      await useVenueImages(bakery);
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
