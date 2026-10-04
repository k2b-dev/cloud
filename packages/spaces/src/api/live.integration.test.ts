import { afterAll, beforeAll, expect, test } from "bun:test";
import { get as getSetting, serviceAccountCredentials } from "@k2b/cloud/services";
import { createTestAppSession, createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { publicCloudOrigin } from "@k2b/cloud/shared";
import { sql } from "bun";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { newShortId } from "../lib/short-id";
import { spacesService } from "../service";
import api from ".";

// Delivery itself is covered by the platform's live routes test; this file checks
// that the Spaces channel admits exactly the readers the Spaces API admits.
const suite = suiteFor("database", "nats", "valkey");
const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;

let server: ReturnType<typeof Bun.serve> | null = null;
let origin = "";
const users: string[] = [];
const spaces: string[] = [];
const accounts: string[] = [];

beforeAll(async () => {
  if (!testInfra.database || !testInfra.nats || !testInfra.valkey) return;
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: new Hono().route("/api/spaces", api).fetch, websocket });
  origin = publicCloudOrigin(await getSetting<string>("app.url"));
});

afterAll(async () => {
  await server?.stop(true);
  if (spaces.length > 0) {
    await sql`DELETE FROM events.outbox WHERE app_id = 'spaces' AND ordering_key IN ${sql(spaces)}`;
    await sql`DELETE FROM spaces.spaces WHERE id IN ${sql(spaces)}`;
  }
  if (accounts.length > 0) await sql`DELETE FROM auth.service_accounts WHERE id IN ${sql(accounts)}`;
  if (users.length > 0) {
    await sql`DELETE FROM auth.access WHERE user_id IN ${sql(users)}`;
    await sql`DELETE FROM auth.users WHERE id IN ${sql(users)}`;
  }
});

const person = async (name: string, admin = false) => {
  const id = crypto.randomUUID();
  await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name, admin)
    VALUES (${id}::uuid, ${`spaces-live-${id}`}, 'local', 'user', ${name}, ${admin})`;
  users.push(id);
  return { id, headers: { cookie: `session_token=${await createTestSession(id)}`, origin, "x-forwarded-for": uniqueCallerAddress() } };
};

const space = async (name: string, creatorId: string) => {
  const created = await spacesService.space.create({ data: { name, color: "#3b82f6" }, creatorId });
  if (!created.ok) throw new Error(created.error);
  const [row] = await sql<{ short_id: string }[]>`SELECT short_id FROM spaces.spaces WHERE id = ${created.data.id}::uuid`;
  spaces.push(created.data.id);
  return { id: created.data.id, shortId: row!.short_id };
};

/** A service account with a grant on `spaceId` and an API key with `scopes`. */
const keyFor = async (account: { kind: "standalone" } | { kind: "resource_bound"; spaceId: string }, spaceId: string, scopes: string[]) => {
  const [created] =
    account.kind === "standalone"
      ? await sql<
          { id: string }[]
        >`INSERT INTO auth.service_accounts (name, kind) VALUES (${`Live ${newShortId()}`}, 'standalone') RETURNING id`
      : await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
          VALUES (${`Live ${newShortId()}`}, 'resource_bound', 'spaces', 'space', ${account.spaceId}) RETURNING id`;
  accounts.push(created!.id);
  const [access] = await sql<{ id: string }[]>`
    INSERT INTO auth.access (service_account_id, permission) VALUES (${created!.id}::uuid, 'read') RETURNING id`;
  await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${spaceId}::uuid, ${access!.id}::uuid)`;
  const key = await serviceAccountCredentials.createApiToken({ serviceAccountId: created!.id, name: "live", scopes });
  if (!key.ok) throw new Error(key.error.message);
  return { headers: { authorization: `Bearer ${key.data.token}`, "x-forwarded-for": uniqueCallerAddress() }, accessId: access!.id };
};

/** Opens the Spaces live socket, sends one subscription, and returns its first answer. */
const firstAnswer = async (headers: Record<string, string>, scope: unknown) => {
  const socket = new BunWebSocket(`ws://127.0.0.1:${server?.port}/api/spaces/live`, { headers });
  try {
    return await new Promise<{ t: string; id?: string; code?: string }>((resolve, reject) => {
      socket.onopen = () => socket.send(JSON.stringify({ t: "sub", id: "s", channel: "space", scope }));
      socket.onmessage = (message) => {
        const frame = JSON.parse(String(message.data)) as { t: string; id?: string; code?: string };
        if (frame.t !== "progress") resolve(frame);
      };
      socket.onerror = () => reject(new Error("The Spaces live socket failed"));
    });
  } finally {
    socket.close();
  }
};

const notFound = { t: "revoked", id: "s", code: "not_found" };

suite("Spaces live channel", () => {
  test("a Space is readable on the live socket exactly when the Spaces API lets its caller read it", async () => {
    const owner = await person("Ada Example");
    const stranger = await person("Bob Example");
    const admin = await person("Cleo Admin", true);
    const shared = await space("Live shared", owner.id);
    const other = await space("Live other", owner.id);

    expect(await firstAnswer(owner.headers, { space: shared.shortId })).toMatchObject({ t: "ready" });
    expect(await firstAnswer(stranger.headers, { space: shared.shortId })).toEqual(notFound);
    expect(await firstAnswer(stranger.headers, { space: "Zz9999" })).toEqual(notFound);
    // A global role grants no Space, on the API as on the socket.
    expect((await api.request(`/${shared.shortId}`, { headers: admin.headers })).status).toBe(403);
    expect(await firstAnswer(admin.headers, { space: shared.shortId })).toEqual(notFound);

    // A Space API key reads its own Space and nothing else, even with a grant on another.
    const bound = await keyFor({ kind: "resource_bound", spaceId: shared.id }, shared.id, ["read"]);
    await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${other.id}::uuid, ${bound.accessId}::uuid)`;
    expect((await api.request(`/${other.shortId}`, { headers: bound.headers })).status).toBe(403);
    expect(await firstAnswer(bound.headers, { space: shared.shortId })).toMatchObject({ t: "ready" });
    expect(await firstAnswer(bound.headers, { space: other.shortId })).toEqual(notFound);
  });

  test("credentials of one principal that the API treats differently never share a live decision", async () => {
    const owner = await person("Dana Example");
    const board = await space("Live scoped", owner.id);

    // A standalone account with a grant on the Space; only its key with the read scope may read it.
    const reader = await keyFor({ kind: "standalone" }, board.id, ["read"]);
    const [unscopedKey] = await sql<{ service_account_id: string }[]>`
      SELECT service_account_id FROM auth.access WHERE id = ${reader.accessId}::uuid`;
    const unscoped = await serviceAccountCredentials.createApiToken({
      serviceAccountId: unscopedKey!.service_account_id,
      name: "live",
      scopes: [],
    });
    if (!unscoped.ok) throw new Error(unscoped.error.message);
    const unscopedHeaders = { authorization: `Bearer ${unscoped.data.token}`, "x-forwarded-for": uniqueCallerAddress() };
    expect((await api.request(`/${board.shortId}`, { headers: reader.headers })).status).toBe(200);
    expect((await api.request(`/${board.shortId}`, { headers: unscopedHeaders })).status).toBe(403);
    // Asked right after the allowed key, inside the 2-second decision cache.
    expect(await firstAnswer(reader.headers, { space: board.shortId })).toMatchObject({ t: "ready" });
    expect(await firstAnswer(unscopedHeaders, { space: board.shortId })).toEqual(notFound);

    // The owner's phone reads the Space like the owner.
    const phone = {
      cookie: `pwa_session=${(await createTestAppSession(owner.id)).token}`,
      origin,
      "x-forwarded-for": uniqueCallerAddress(),
    };
    expect(await firstAnswer(phone, { space: board.shortId })).toMatchObject({ t: "ready" });
  });

  test("a tab from before the move to /live is asked to load the page again", async () => {
    const socket = new BunWebSocket(`ws://127.0.0.1:${server?.port}/api/spaces/ws`, {
      headers: { "x-forwarded-for": uniqueCallerAddress() },
    });
    const answer = await new Promise<unknown>((resolve) => {
      socket.onmessage = (message) => resolve(JSON.parse(String(message.data)));
    });
    expect(answer).toMatchObject({ type: "spaces.live.error", payload: { code: "resync_required" } });
    socket.close();
  });
});
