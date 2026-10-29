import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeAppMeta } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { createTestAppSession, createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { createConfig } from "@k2b/ssr";
import { sql } from "bun";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { newShortId } from "../lib/short-id";

const root = mkdtempSync(join(tmpdir(), "spaces-pwa-integration-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { pwaRoutes } = await import("./index");
const { app } = await import("../config");
const { default: api } = await import("../api");

const suite = suiteFor("database", "nats", "valkey");
setDefaultTimeout(60_000);

const shell: RuntimeAppMeta = { id: "pwa", name: "Mobile app", icon: "ti ti-device-mobile", description: "", routes: ["/pwa"] };
const server = new Hono<AuthContext>()
  .use("*", async (c, next) => {
    c.set("runtime" as never, { apps: [shell, app.meta] } as never);
    c.set("settings" as never, { app: { name: "Example Cloud" } } as never);
    await next();
  })
  .route("/pwa/spaces", pwaRoutes)
  .route("/api/spaces", api);

const origin = "https://cloud.example.test";
const document = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
const script = { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" };
const users: string[] = [];
const spaces: string[] = [];

suite("Spaces in the Cloud app", () => {
  afterAll(async () => {
    for (const id of spaces) await sql`DELETE FROM spaces.spaces WHERE id = ${id}::uuid`;
    for (const id of users) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  });

  test("only an app session opens the part, and a task the person claimed and checked off there is done on the web", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name)
      VALUES (${`spaces-pwa-${suffix}`}, 'local', 'user', 'Mia Muster') RETURNING id`;
    users.push(user!.id);
    const [space] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO spaces.spaces (short_id, name) VALUES (${newShortId()}, ${`Summer fair ${suffix}`}) RETURNING id, short_id`;
    spaces.push(space!.id);
    const [access] = await sql<{ id: string }[]>`
      INSERT INTO auth.access (user_id, permission) VALUES (${user!.id}::uuid, 'write') RETURNING id`;
    await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${space!.id}::uuid, ${access!.id}::uuid)`;
    const [column] = await sql<{ id: string }[]>`
      INSERT INTO spaces.columns (short_id, space_id, name, rank) VALUES (${newShortId()}, ${space!.id}::uuid, 'Open', 1024) RETURNING id`;
    const [item] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO spaces.items (short_id, space_id, column_id, title)
      VALUES (${newShortId()}, ${space!.id}::uuid, ${column!.id}::uuid, 'Order the tents') RETURNING id, short_id`;
    await sql`INSERT INTO spaces.item_assignees (item_id, user_id) VALUES (${item!.id}::uuid, ${user!.id}::uuid)`;

    const web = `session_token=${await createTestSession(user!.id)}`;
    const phone = `pwa_session=${(await createTestAppSession(user!.id)).token}`;

    // The web session never reaches the part, whether the browser navigates or a script fetches.
    for (const mode of [document, script]) {
      const response = await server.request(`${origin}/pwa/spaces?view=mine`, { headers: { cookie: web, ...mode } });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`/pwa/_auth/session/launch?to=${encodeURIComponent("/pwa/spaces?view=mine")}`);
      expect(await response.text()).not.toContain("Order the tents");
    }

    const page = await server.request(`${origin}/pwa/spaces`, { headers: { cookie: phone, ...document } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Order the tents");
    expect(html).toContain(`Mark “Order the tents” as done`);

    // The person claims the task on the web with I'm on it; the phone completes it with that claim, as the web does.
    const itemPath = `${origin}/api/spaces/${space!.short_id}/items/${item!.short_id}`;
    const post = (cookie: string, path: string, body: unknown) =>
      server.request(`${itemPath}/${path}`, {
        method: "POST",
        headers: { cookie, origin, "content-type": "application/json", "x-forwarded-for": uniqueCallerAddress() },
        body: JSON.stringify(body),
      });
    const claimId = crypto.randomUUID();
    expect((await post(web, "claim", { claimId })).status).toBe(200);
    expect((await post(phone, "completed", { completed: true })).status).toBe(409);
    const read = await server.request(itemPath, { headers: { cookie: phone } });
    expect(read.status).toBe(200);
    expect(((await read.json()) as { claim: { id: string; actor: { kind: string; id: string } } }).claim).toMatchObject({
      id: claimId,
      actor: { kind: "user", id: user!.id },
    });
    expect((await post(phone, "completed", { completed: true, claimId })).status).toBe(200);

    const onTheWeb = await server.request(`${origin}/api/spaces/overview/work?view=mine`, { headers: { cookie: web } });
    expect(onTheWeb.status).toBe(200);
    const work = (await onTheWeb.json()) as { items: { shortId: string }[]; counts: { mine: number } };
    expect(work.items.map((entry) => entry.shortId)).not.toContain(item!.short_id);
    expect(work.counts.mine).toBe(0);
  });

  test("a task opens at its own address only for readers of its Space, and only write access may change it", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const person = async (uid: string) => {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO auth.users (uid, provider, profile, display_name)
        VALUES (${`${uid}-${suffix}`}, 'local', 'user', ${uid}) RETURNING id`;
      users.push(row!.id);
      return row!.id;
    };
    const [writer, reader, stranger] = [
      await person("spaces-pwa-writer"),
      await person("spaces-pwa-reader"),
      await person("spaces-pwa-stranger"),
    ];
    const newSpace = async (name: string) => {
      const [row] = await sql<{ id: string; short_id: string }[]>`
        INSERT INTO spaces.spaces (short_id, name, color) VALUES (${newShortId()}, ${`${name} ${suffix}`}, '#16a34a') RETURNING id, short_id`;
      spaces.push(row!.id);
      return row!;
    };
    const [fair, other] = [await newSpace("Summer fair"), await newSpace("Other")];
    for (const [userId, permission, space] of [
      [writer, "write", fair],
      [reader, "read", fair],
      [stranger, "write", other],
    ] as const) {
      const [access] = await sql<{ id: string }[]>`
        INSERT INTO auth.access (user_id, permission) VALUES (${userId}::uuid, ${permission}) RETURNING id`;
      await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${space.id}::uuid, ${access!.id}::uuid)`;
    }
    const [column] = await sql<{ id: string }[]>`
      INSERT INTO spaces.columns (short_id, space_id, name, rank) VALUES (${newShortId()}, ${fair.id}::uuid, 'Open', 1024) RETURNING id`;
    const [item] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO spaces.items (short_id, space_id, column_id, title, description)
      VALUES (${newShortId()}, ${fair.id}::uuid, ${column!.id}::uuid, 'Order the tents', 'Two large tents.') RETURNING id, short_id`;
    await sql`INSERT INTO spaces.item_assignees (item_id, user_id) VALUES (${item!.id}::uuid, ${writer}::uuid)`;
    const [entry] = await sql<{ short_id: string }[]>`
      INSERT INTO spaces.item_checklist_entries (short_id, item_id, label, completed, rank)
      VALUES (${newShortId()}, ${item!.id}::uuid, 'Ask the rental', false, 1024) RETURNING short_id`;

    const read = async (userId: string, path: string, accept = "application/json") => {
      const cookie = `pwa_session=${(await createTestAppSession(userId)).token}`;
      return server.request(`${origin}${path}`, { headers: { cookie, accept, ...document } });
    };
    const address = `/pwa/spaces/${fair.short_id}/${item!.short_id}`;

    const own = await read(writer, address);
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({
      shortId: item!.short_id,
      spaceShortId: fair.short_id,
      title: "Order the tents",
      description: "Two large tents.",
      people: [{ id: writer, kind: "user" }],
      checklist: [{ id: entry!.short_id, label: "Ask the rental", completed: false }],
      canWrite: true,
    });
    const page = await read(writer, address, "text/html");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Two large tents.");

    const readOnly = await read(reader, address);
    expect(((await readOnly.json()) as { canWrite: boolean }).canWrite).toBe(false);

    // Neither a stranger nor an address that puts the task in another Space learns that it exists.
    for (const [userId, path] of [
      [stranger, address],
      [stranger, `/pwa/spaces/${other.short_id}/${item!.short_id}`],
      [writer, `/pwa/spaces/${other.short_id}/${item!.short_id}`],
    ] as const) {
      for (const accept of ["application/json", "text/html"]) {
        const response = await read(userId, path, accept);
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain("Order the tents");
      }
    }
  });
});
