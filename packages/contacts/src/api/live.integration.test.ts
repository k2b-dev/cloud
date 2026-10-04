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
import { contactsService } from "../service";
import api from ".";

// Delivery itself is covered by the platform's live routes test; this file checks
// that the Contacts channels admit exactly the readers the Contacts API admits.
const suite = suiteFor("database", "nats", "valkey");
const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;

let server: ReturnType<typeof Bun.serve> | null = null;
let origin = "";
const users: string[] = [];
const books: { id: string; shortId: string }[] = [];
const accounts: string[] = [];

beforeAll(async () => {
  if (!testInfra.database || !testInfra.nats || !testInfra.valkey) return;
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: new Hono().route("/api/contacts", api).fetch, websocket });
  origin = publicCloudOrigin(await getSetting<string>("app.url"));
});

afterAll(async () => {
  await server?.stop(true);
  if (books.length > 0) {
    const ids = books.map((book) => book.id);
    await sql`DELETE FROM events.outbox WHERE app_id = 'contacts' AND ordering_key IN ${sql(ids)}`;
    await sql`DELETE FROM contacts.books WHERE id IN ${sql(ids)}`;
  }
  if (accounts.length > 0) await sql`DELETE FROM auth.service_accounts WHERE id IN ${sql(accounts)}`;
  if (users.length > 0) await sql`DELETE FROM auth.users WHERE id IN ${sql(users)}`;
});

const person = async (name: string, admin = false) => {
  const id = crypto.randomUUID();
  await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name, admin)
    VALUES (${id}::uuid, ${`contacts-live-${id}`}, 'local', 'user', ${name}, ${admin})`;
  users.push(id);
  return { id, headers: { cookie: `session_token=${await createTestSession(id)}`, origin, "x-forwarded-for": uniqueCallerAddress() } };
};

const book = async (name: string, creatorId: string) => {
  const created = await contactsService.book.create({ data: { name }, creatorId });
  if (!created.ok) throw new Error(created.error.message);
  const [row] = await sql<{ short_id: string }[]>`SELECT short_id FROM contacts.books WHERE id = ${created.data.id}::uuid`;
  books.push({ id: created.data.id, shortId: row!.short_id });
  return { id: created.data.id, shortId: row!.short_id };
};

/** Opens the Contacts live socket, sends one subscription, and returns its first answer. */
const firstAnswer = async (headers: Record<string, string>, channel: string, scope: unknown) => {
  const socket = new BunWebSocket(`ws://127.0.0.1:${server?.port}/api/contacts/live`, { headers });
  try {
    return await new Promise<{ t: string; id?: string; code?: string }>((resolve, reject) => {
      socket.onopen = () => socket.send(JSON.stringify({ t: "sub", id: "s", channel, scope }));
      socket.onmessage = (message) => {
        const frame = JSON.parse(String(message.data)) as { t: string; id?: string; code?: string };
        if (frame.t !== "progress") resolve(frame);
      };
      socket.onerror = () => reject(new Error("The Contacts live socket failed"));
    });
  } finally {
    socket.close();
  }
};

suite("Contacts live channels", () => {
  test("a book is readable on the live socket exactly when the Contacts API lets its caller read it", async () => {
    const owner = await person("Ada Example");
    const stranger = await person("Bob Example");
    const admin = await person("Cleo Admin", true);
    const shared = await book("Live shared", owner.id);
    const other = await book("Live other", owner.id);

    expect(await firstAnswer(owner.headers, "book", { book: shared.shortId })).toMatchObject({ t: "ready" });
    expect(await firstAnswer(stranger.headers, "book", { book: shared.shortId })).toEqual({ t: "revoked", id: "s", code: "not_found" });
    expect(await firstAnswer(stranger.headers, "book", { book: "Zz9999" })).toEqual({ t: "revoked", id: "s", code: "not_found" });
    expect(await firstAnswer(admin.headers, "book", { book: shared.shortId })).toMatchObject({ t: "ready" });
    expect(await firstAnswer(stranger.headers, "all", {})).toMatchObject({ t: "ready" });

    // A book API key reads its own book and nothing else, like on the REST API.
    const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
      VALUES ('Live key', 'resource_bound', 'contacts', 'contact_book', ${shared.id}) RETURNING id`;
    accounts.push(account!.id);
    const [access] = await sql<
      { id: string }[]
    >`INSERT INTO auth.access (service_account_id, permission) VALUES (${account!.id}::uuid, 'read') RETURNING id`;
    await sql`INSERT INTO contacts.book_access (book_id, access_id) VALUES (${shared.id}::uuid, ${access!.id}::uuid), (${other.id}::uuid, ${access!.id}::uuid)`;
    const key = await serviceAccountCredentials.createApiToken({ serviceAccountId: account!.id, name: "live", scopes: ["read"] });
    if (!key.ok) throw new Error(key.error.message);
    const bearer = { authorization: `Bearer ${key.data.token}`, "x-forwarded-for": uniqueCallerAddress() };
    expect((await api.request(`/books/${other.shortId}`, { headers: bearer })).status).toBe(403);
    expect(await firstAnswer(bearer, "book", { book: shared.shortId })).toMatchObject({ t: "ready" });
    expect(await firstAnswer(bearer, "book", { book: other.shortId })).toEqual({ t: "revoked", id: "s", code: "not_found" });
  });

  test("credentials of one principal that the API treats differently never share a live decision", async () => {
    const owner = await person("Dana Example");
    const admin = await person("Eli Admin", true);
    const book1 = await book("Live scoped", owner.id);

    // A standalone account with a grant on the book; only its key with the read scope may read it.
    const [account] = await sql<
      { id: string }[]
    >`INSERT INTO auth.service_accounts (name, kind) VALUES ('Live sync', 'standalone') RETURNING id`;
    accounts.push(account!.id);
    const [access] = await sql<
      { id: string }[]
    >`INSERT INTO auth.access (service_account_id, permission) VALUES (${account!.id}::uuid, 'read') RETURNING id`;
    await sql`INSERT INTO contacts.book_access (book_id, access_id) VALUES (${book1.id}::uuid, ${access!.id}::uuid)`;
    const bearerFor = async (scopes: string[]) => {
      const key = await serviceAccountCredentials.createApiToken({ serviceAccountId: account!.id, name: "live", scopes });
      if (!key.ok) throw new Error(key.error.message);
      return { authorization: `Bearer ${key.data.token}`, "x-forwarded-for": uniqueCallerAddress() };
    };
    const reader = await bearerFor(["read"]);
    const unscoped = await bearerFor([]);
    expect((await api.request(`/books/${book1.shortId}`, { headers: reader })).status).toBe(200);
    expect((await api.request(`/books/${book1.shortId}`, { headers: unscoped })).status).toBe(403);
    // Asked right after the allowed key, inside the 2-second decision cache.
    expect(await firstAnswer(reader, "book", { book: book1.shortId })).toMatchObject({ t: "ready" });
    expect(await firstAnswer(unscoped, "book", { book: book1.shortId })).toEqual({ t: "revoked", id: "s", code: "not_found" });

    // An administrator's phone holds no admin role, so it does not read a book through it.
    const phone = {
      cookie: `pwa_session=${(await createTestAppSession(admin.id)).token}`,
      origin,
      "x-forwarded-for": uniqueCallerAddress(),
    };
    expect((await api.request(`/books/${book1.shortId}`, { headers: admin.headers })).status).toBe(200);
    expect((await api.request(`/books/${book1.shortId}`, { headers: phone })).status).toBe(403);
    expect(await firstAnswer(admin.headers, "book", { book: book1.shortId })).toMatchObject({ t: "ready" });
    expect(await firstAnswer(phone, "book", { book: book1.shortId })).toEqual({ t: "revoked", id: "s", code: "not_found" });
  });

  test("a tab from before the move to /live is asked to load the page again, without sending anything", async () => {
    const socket = new BunWebSocket(`ws://127.0.0.1:${server?.port}/api/contacts/ws`, {
      headers: { "x-forwarded-for": uniqueCallerAddress() },
    });
    const answer = await new Promise<unknown>((resolve) => {
      socket.onmessage = (message) => resolve(JSON.parse(String(message.data)));
    });
    expect(answer).toMatchObject({ type: "contacts.live.error", payload: { code: "resync_required" } });
    socket.close();
  });
});
