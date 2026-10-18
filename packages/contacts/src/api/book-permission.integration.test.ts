import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import type { CapabilityExecutionContext, CloudRuntime } from "@k2b/cloud/contracts";
import { type AuthContext, auth, userFromActor } from "@k2b/cloud/server";
import { get as getSetting, serviceAccountCredentials } from "@k2b/cloud/services";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { publicCloudOrigin } from "@k2b/cloud/shared";
import { sql } from "bun";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { contactsCapabilities } from "../capabilities";
import "../frontend/_components/ssr-test-plugin";
import api from ".";

const { default: pages } = await import("../frontend");
const suite = suiteFor("database", "nats", "valkey");
setDefaultTimeout(30_000);

const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>()
  .use("*", async (c, next) => {
    c.set("runtime", { apps: [] });
    await next();
  })
  .route("/api/contacts", api)
  .route("/app/contacts", pages);
const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
type Subject = { headers: Record<string, string>; ssr: boolean };
type Book = { id: string; shortId: string; contactId: string; suffix: string };
const users: string[] = [];
const books: Book[] = [];
const accounts: string[] = [];
const accessIds: string[] = [];
let server: ReturnType<typeof Bun.serve> | null = null;
let origin = "";

const person = async (name: string, admin = false) => {
  const id = crypto.randomUUID();
  await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name, admin)
    VALUES (${id}::uuid, ${`contacts-permission-${id}`}, 'local', 'user', ${name}, ${admin})`;
  users.push(id);
  return {
    id,
    headers: { cookie: `session_token=${await createTestSession(id)}`, origin, "x-forwarded-for": uniqueCallerAddress() },
    ssr: true,
  };
};

const grant = async (
  bookId: string,
  principal: { userId: string } | { serviceAccountId: string },
  permission: "read" | "write" | "admin" = "read",
) => {
  const [row] = await sql<{ id: string }[]>`INSERT INTO auth.access (user_id, service_account_id, permission)
    VALUES (${"userId" in principal ? principal.userId : null}::uuid,
      ${"serviceAccountId" in principal ? principal.serviceAccountId : null}::uuid, ${permission}::auth.permission_level) RETURNING id`;
  accessIds.push(row!.id);
  await sql`INSERT INTO contacts.book_access (book_id, access_id) VALUES (${bookId}::uuid, ${row!.id}::uuid)`;
};

// Fixtures use SQL and the HTTP API, never internal Contacts service functions.
const book = async (name: string, owner: Awaited<ReturnType<typeof person>>): Promise<Book> => {
  const id = crypto.randomUUID();
  const shortId = crypto.randomUUID().replaceAll("-", "").slice(0, 6);
  const entry = { id, shortId, contactId: "", suffix: crypto.randomUUID() };
  // A unique name query keeps book.list assertions independent of existing books and pagination.
  await sql`INSERT INTO contacts.books (id, short_id, name) VALUES (${id}::uuid, ${shortId}, ${`${name} ${entry.suffix}`})`;
  books.push(entry);
  await grant(id, { userId: owner.id }, "admin");
  const response = await app.request(`/api/contacts/books/${shortId}/contacts`, {
    method: "POST",
    headers: { ...owner.headers, "content-type": "application/json" },
    body: JSON.stringify({ firstName: "Permission fixture", emails: [{ email: `fixture.${entry.suffix}@example.test` }] }),
  });
  expect(response.status).toBe(200);
  entry.contactId = ((await response.json()) as { id: string }).id;
  return entry;
};

const apiToken = async (serviceAccountId: string, scopes: string[]): Promise<Subject> => {
  const created = await serviceAccountCredentials.createApiToken({ serviceAccountId, name: "Book permission reproduction", scopes });
  if (!created.ok) throw new Error(created.error.message);
  return {
    headers: { authorization: `Bearer ${created.data.token}`, origin, "x-forwarded-for": uniqueCallerAddress() },
    // Contacts SSR is a user-role surface; machine credentials are exercised through API, capabilities, and live.
    ssr: false,
  };
};

const account = async (kind: "agent" | "standalone" | "resource_bound", boundBook?: Book) => {
  const [row] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
    VALUES (${`Book permission ${kind} ${crypto.randomUUID()}`}, ${kind}, ${boundBook ? "contacts" : null},
      ${boundBook ? "contact_book" : null}, ${boundBook?.id ?? null}) RETURNING id`;
  accounts.push(row!.id);
  return row!.id;
};

const capabilityContext = async (subject: Subject): Promise<CapabilityExecutionContext> => {
  // Capture the real resolved objects, including credential scopes and resource binding, without JSON round-tripping.
  let captured: CapabilityExecutionContext | undefined;
  const probe = new Hono<AuthContext>().get("/whoami", auth.requireRole("authenticated"), (c) => {
    const actor = c.get("actor");
    captured = {
      actor,
      accessSubject: c.get("accessSubject"),
      user: userFromActor(actor),
      locale: "en",
      requestId: crypto.randomUUID(),
      origin: "app",
      signal: c.req.raw.signal,
    };
    return c.json({ ok: true });
  });
  expect((await probe.request("/whoami", { headers: subject.headers })).status).toBe(200);
  if (!captured) throw new Error("The platform did not resolve a capability context");
  return captured;
};

/** Subscribe once and close even when the server fails to answer. */
const firstAnswer = async (subject: Subject, target: Book) => {
  const socket = new BunWebSocket(`ws://127.0.0.1:${server?.port}/api/contacts/live`, { headers: subject.headers });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<{ t: string; id?: string; code?: string }>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("The Contacts live socket did not answer")), 5_000);
      socket.onopen = () => socket.send(JSON.stringify({ t: "sub", id: "s", channel: "book", scope: { book: target.shortId } }));
      socket.onmessage = (message) => {
        const frame = JSON.parse(String(message.data)) as { t: string; id?: string; code?: string };
        if (frame.t !== "progress") resolve(frame.t === "ready" ? { t: "ready" } : frame);
      };
      socket.onerror = () => reject(new Error("The Contacts live socket failed"));
      socket.onclose = () => reject(new Error("The Contacts live socket closed before answering"));
    });
  } finally {
    clearTimeout(timer);
    socket.close();
  }
};

const outcome = (result: { ok: boolean; error?: { code: string } }) => (result.ok ? "ok" : result.error?.code);

/** Collect every surface before asserting, so an API regression does not hide the capability/live disagreement. */
const observe = async (subject: Subject, target: Book) => {
  const context = await capabilityContext(subject);
  const read = await app.request(`/api/contacts/books/${target.shortId}`, { headers: subject.headers });
  const write = await app.request(`/api/contacts/books/${target.shortId}/contacts`, {
    method: "POST",
    headers: { ...subject.headers, "content-type": "application/json" },
    body: JSON.stringify({ firstName: "HTTP permission probe" }),
  });
  const queries = contactsCapabilities.queries;
  const bookRead = await queries["book.read"].run({ id: target.shortId }, context);
  const contactRead = await queries["contact.read"].run({ id: target.contactId }, context);
  const listed = await queries["book.list"].run({ query: target.suffix, minimumPermission: "read", limit: 100 }, context);
  const suggested = await queries["contact.suggest"].run({ query: target.suffix, limit: 25 }, context);
  const action = contactsCapabilities.actions["contact.create"];
  const created = await action.run(action.input.parse({ bookId: target.shortId, firstName: "Capability permission probe" }), {
    ...context,
    idempotencyKey: crypto.randomUUID(),
  });
  return {
    api: read.status,
    write: write.status,
    capability: {
      book: outcome(bookRead),
      contact: outcome(contactRead),
      write: outcome(created),
      list: listed.ok ? listed.data.data.filter((item) => item.id === target.shortId).map((item) => item.permission) : outcome(listed),
      suggest: suggested.ok ? suggested.data.data.some((item) => item.contactId === target.contactId) : outcome(suggested),
    },
    ssr: subject.ssr ? (await app.request(`/app/contacts/${target.shortId}`, { headers: subject.headers })).status : null,
    live: await firstAnswer(subject, target),
  };
};

const expectAgreement = async (subject: Subject, target: Book, read: boolean, write = false, scoped = true) => {
  expect(await observe(subject, target)).toEqual({
    api: read ? 200 : 403,
    write: write ? 200 : 403,
    capability: {
      book: read ? "ok" : "FORBIDDEN",
      contact: read ? "ok" : "FORBIDDEN",
      write: write ? "ok" : "FORBIDDEN",
      list: scoped ? (read ? [write ? "admin" : "read"] : []) : "FORBIDDEN",
      suggest: scoped ? read : "FORBIDDEN",
    },
    ssr: subject.ssr ? (read ? 200 : 403) : null,
    live: read ? { t: "ready" } : { t: "revoked", id: "s", code: "not_found" },
  });
};

suite("Contacts book grants on every application surface (#1234 option B)", () => {
  let owner: Awaited<ReturnType<typeof person>>;
  let admin: Subject;
  let delegatedAdmin: Subject;
  let reader: Subject;
  let stranger: Subject;
  let adminReader: Subject;
  let agentReader: Subject;
  let agentUnscoped: Subject;
  let standalone: Subject;
  let bound: Subject;
  let b: Book;
  let c: Book;

  beforeAll(async () => {
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, websocket });
    origin = publicCloudOrigin(await getSetting<string>("app.url"));
    owner = await person("Book owner");
    const administrator = await person("Cloud administrator without a grant", true);
    admin = administrator;
    const readOnlyAdmin = await person("Cloud administrator with a read grant", true);
    adminReader = readOnlyAdmin;
    const readOnlyUser = await person("Book reader");
    reader = readOnlyUser;
    stranger = await person("No grants");
    b = await book("Permission B", owner);
    c = await book("Permission C", owner);
    await grant(b.id, { userId: readOnlyUser.id });
    await grant(b.id, { userId: readOnlyAdmin.id });

    // The same real platform function used by createUserApiToken creates the delegated account;
    // createApiToken lets this fixture explicitly request read+write scopes.
    const delegated = await serviceAccountCredentials.getOrCreateUserDelegatedServiceAccount({ userId: administrator.id });
    if (!delegated.ok) throw new Error(delegated.error.message);
    accounts.push(delegated.data.id);
    delegatedAdmin = await apiToken(delegated.data.id, ["read", "write"]);
    const agent = await account("agent");
    await grant(b.id, { serviceAccountId: agent });
    agentReader = await apiToken(agent, ["read"]);
    agentUnscoped = await apiToken(agent, ["openid"]);
    const sync = await account("standalone");
    await grant(b.id, { serviceAccountId: sync });
    standalone = await apiToken(sync, ["read"]);
    const key = await account("resource_bound", b);
    await grant(b.id, { serviceAccountId: key });
    await grant(c.id, { serviceAccountId: key });
    bound = await apiToken(key, ["read"]);
  });

  afterAll(async () => {
    await server?.stop(true);
    if (books.length) {
      const ids = books.map((item) => item.id);
      await sql`DELETE FROM events.outbox WHERE app_id = 'contacts' AND ordering_key IN ${sql(ids)}`;
      // Idempotency records intentionally survive contact deletion, so remove fixture records explicitly.
      await sql`DELETE FROM contacts.capability_action_results WHERE contact_id IN (
        SELECT id FROM contacts.contacts WHERE book_id IN ${sql(ids)}
      )`;
      await sql`DELETE FROM contacts.books WHERE id IN ${sql(ids)}`;
    }
    if (accounts.length) {
      await sql`DELETE FROM auth.service_account_credentials WHERE service_account_id IN ${sql(accounts)}`;
      await sql`DELETE FROM auth.access WHERE service_account_id IN ${sql(accounts)}`;
      await sql`DELETE FROM auth.service_accounts WHERE id IN ${sql(accounts)}`;
    }
    if (accessIds.length) await sql`DELETE FROM auth.access WHERE id IN ${sql(accessIds)}`;
    if (users.length) {
      await sql`DELETE FROM auth.access WHERE user_id IN ${sql(users)}`;
      await sql`DELETE FROM auth.users WHERE id IN ${sql(users)}`;
    }
  });

  // Cloud administration belongs at /admin/contacts; it grants nothing inside the Contacts app.
  test.each(["session", "user-delegated key"] as const)("a Cloud admin without a book grant is denied through a %s", async (credential) => {
    await expectAgreement(credential === "session" ? admin : delegatedAdmin, b, false);
  });

  test("a Cloud admin without a book grant cannot open the in-app book settings, access, or API keys", async () => {
    const base = `/api/contacts/books/${b.shortId}`;
    const statuses = {
      admin: {
        settings: (await app.request(`${base}/settings-context`, { headers: admin.headers })).status,
        access: (await app.request(`${base}/access`, { headers: admin.headers })).status,
        updateAccess: (
          await app.request(`${base}/access/${crypto.randomUUID()}`, {
            method: "PATCH",
            headers: { ...admin.headers, "content-type": "application/json" },
            body: JSON.stringify({ permission: "read" }),
          })
        ).status,
        apiKeys: (await app.request(`${base}/api-keys`, { headers: admin.headers })).status,
      },
      owner: {
        settings: (await app.request(`${base}/settings-context`, { headers: owner.headers })).status,
        access: (await app.request(`${base}/access`, { headers: owner.headers })).status,
        apiKeys: (await app.request(`${base}/api-keys`, { headers: owner.headers })).status,
      },
    };
    expect(statuses).toEqual({
      admin: { settings: 403, access: 403, updateAccess: 403, apiKeys: 403 },
      owner: { settings: 200, access: 200, apiKeys: 200 },
    });
  });

  test.each(["reader", "stranger", "admin reader", "owner"] as const)("a %s follows only their book grant", async (kind) => {
    const subject = { reader, stranger, "admin reader": adminReader, owner }[kind];
    await expectAgreement(subject, b, kind !== "stranger", kind === "owner");
  });

  test.each(["agent read", "agent unscoped", "standalone granted", "standalone ungranted", "bound B", "bound C"] as const)(
    "%s respects grants, scopes, and resource binding",
    async (kind) => {
      const rows = {
        "agent read": { subject: agentReader, target: b, read: true },
        "agent unscoped": { subject: agentUnscoped, target: b, read: false },
        "standalone granted": { subject: standalone, target: b, read: true },
        "standalone ungranted": { subject: standalone, target: c, read: false },
        "bound B": { subject: bound, target: b, read: true },
        "bound C": { subject: bound, target: c, read: false },
      };
      const row = rows[kind];
      await expectAgreement(row.subject, row.target, row.read, false, kind !== "agent unscoped");
    },
  );
});
