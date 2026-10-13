// biome-ignore assist/source/organizeImports: Gate test infrastructure before importing application services.
import { testFor } from "../../../../scripts/fixtures/test-infra";
import { expect } from "bun:test";
import { type User, WidgetResponseSchema, type WidgetSettingsDeclaration } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { setWidgetRequest } from "@k2b/cloud/server/widget-request";
import { sql } from "bun";
import { Hono } from "hono";
import { newShortId } from "../lib/short-id";
import { dashboardSnapshot } from "../service/items";
import { spacesTodayWidgetHandler } from "./widgets";

const declaration: WidgetSettingsDeclaration = { space: { kind: "resource", label: "Space", type: "spaces.space" } };

testFor("database")("Today filters every snapshot query and authorizes the selected Space on every call", async () => {
  const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name)
    VALUES (${crypto.randomUUID()}, 'local', 'user', 'Widget settings fixture') RETURNING id`;
  const user: User = {
    id: row!.id,
    uid: "widget-settings-fixture",
    provider: "local",
    profile: "user",
    roles: ["user"],
    givenname: "Widget",
    sn: "Fixture",
    displayName: "Widget Fixture",
    mail: null,
    avatarHash: null,
    accountExpires: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
    ipa: null,
  };
  const spaces: { id: string; shortId: string; name: string }[] = [];
  let accessId: string | undefined;
  try {
    const [access] = await sql<{ id: string }[]>`INSERT INTO auth.access (user_id, permission)
      VALUES (${user.id}::uuid, 'read') RETURNING id`;
    accessId = access!.id;
    for (const name of ["First widget Space", "Second widget Space", "Private widget Space", "Empty widget Space"]) {
      const shortId = newShortId();
      const [space] = await sql<{ id: string }[]>`INSERT INTO spaces.spaces (short_id, name)
        VALUES (${shortId}, ${name}) RETURNING id`;
      spaces.push({ id: space!.id, shortId, name });
      if (name !== "Private widget Space")
        await sql`INSERT INTO spaces.space_access (space_id, access_id)
        VALUES (${space!.id}::uuid, ${accessId}::uuid)`;
      if (name === "Empty widget Space") continue;
      const [column] = await sql<{ id: string }[]>`INSERT INTO spaces.columns (short_id, space_id, name)
        VALUES (${newShortId()}, ${space!.id}::uuid, 'Open') RETURNING id`;
      const [todo] = await sql<{ id: string }[]>`INSERT INTO spaces.items (short_id, space_id, column_id, title, deadline, priority)
        VALUES (${newShortId()}, ${space!.id}::uuid, ${column!.id}::uuid, ${`${name} todo`}, CURRENT_TIMESTAMP + INTERVAL '3 days', 'urgent') RETURNING id`;
      await sql`INSERT INTO spaces.items (short_id, space_id, column_id, title, starts_at, ends_at)
        VALUES (${newShortId()}, ${space!.id}::uuid, ${column!.id}::uuid, ${`${name} event`}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '1 hour')`;
      await sql`INSERT INTO spaces.item_assignees (item_id, user_id) VALUES (${todo!.id}::uuid, ${user.id}::uuid)`;
    }
    const params = { userId: user.id, todoLimit: 6, dateConfig: { locale: "en", timeZone: "UTC" } };
    const all = await dashboardSnapshot(params);
    expect(all).toMatchObject({ openTodoCount: 4, assignedToMeCount: 2, urgentCount: 2, todayCount: 2, upcomingCount: 2 });
    expect(all.events).toHaveLength(2);
    expect(all.todos).toHaveLength(2);
    const first = spaces[0]!;
    const selected = await dashboardSnapshot({ ...params, spaceId: first.id });
    expect(selected).toMatchObject({ openTodoCount: 2, assignedToMeCount: 1, urgentCount: 1, todayCount: 1, upcomingCount: 1 });
    expect(selected.events.map((item) => item.spaceId)).toEqual([first.id]);
    expect(selected.todos.map((item) => item.spaceId)).toEqual([first.id]);
    expect(await dashboardSnapshot({ ...params, spaceId: spaces[2]!.id })).toMatchObject({
      openTodoCount: 0,
      assignedToMeCount: 0,
      urgentCount: 0,
      todayCount: 0,
      upcomingCount: 0,
      events: [],
      todos: [],
    });

    const routes = new Hono<AuthContext>()
      .use(async (c, next) => {
        c.set("actor", { kind: "user", user });
        c.set("user", user);
        c.set("accessSubject", { type: "user", userId: user.id });
        await next();
      })
      .get("/direct", spacesTodayWidgetHandler)
      .get("/widget", (c) => {
        setWidgetRequest(c, { sizes: ["medium", "large"], settings: declaration });
        return spacesTodayWidgetHandler(c);
      });
    const settingsUrl = (id: string) => `/widget?settings=${encodeURIComponent(JSON.stringify({ space: { type: "spaces.space", id } }))}`;
    const response = await routes.request(settingsUrl(first.shortId));
    expect(response.status).toBe(200);
    const body = WidgetResponseSchema.parse(await response.json());
    expect(body.title).toBe(`Today · ${first.name}`);
    expect(body.href).toBe(`/app/spaces/${first.shortId}`);
    expect(body.blocks).toHaveLength(1);
    const list = body.blocks[0]!;
    expect(list.kind).toBe("list");
    if (list.kind !== "list") throw new Error("Expected today's list");
    expect(list.items.map((item) => item.sub)).toEqual([first.name, first.name]);
    expect(list.items.every((item) => item.href?.startsWith(`/app/spaces/${first.shortId}?item=`))).toBe(true);
    const german = await routes.request(settingsUrl(first.shortId), { headers: { "x-cloud-locale": "de-CH" } });
    expect(WidgetResponseSchema.parse(await german.json()).title).toBe(`Heute · ${first.name}`);
    const empty = await routes.request(settingsUrl(spaces[3]!.shortId));
    expect(WidgetResponseSchema.parse(await empty.json())).toMatchObject({
      title: `Today · ${spaces[3]!.name}`,
      href: `/app/spaces/${spaces[3]!.shortId}`,
      blocks: [{ kind: "hero" }],
    });

    const without = await routes.request("/widget");
    const direct = await routes.request("/direct");
    const original = await direct.text();
    expect(await without.text()).toBe(original);
    const invalid = await routes.request(
      `/widget?settings=${encodeURIComponent(JSON.stringify({ space: { type: "files.file", id: first.shortId } }))}`,
    );
    expect(await invalid.text()).toBe(original);
    expect(WidgetResponseSchema.parse(JSON.parse(original))).toMatchObject({ title: "Today", href: "/app/spaces" });
    for (const id of [newShortId(), "not-a-short-id", spaces[2]!.shortId]) {
      const denied = await routes.request(settingsUrl(id));
      expect(denied.status).toBe(403);
      expect(await denied.text()).toBe("");
    }
    await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
    expect((await routes.request(settingsUrl(first.shortId))).status).toBe(403);
    expect(await dashboardSnapshot({ ...params, spaceId: first.id })).toMatchObject({ openTodoCount: 0, events: [], todos: [] });
  } finally {
    for (const space of spaces) await sql`DELETE FROM spaces.spaces WHERE id = ${space.id}::uuid`;
    if (accessId) await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
    await sql`DELETE FROM auth.users WHERE id = ${user.id}::uuid`;
  }
});
