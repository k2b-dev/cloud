import { afterAll, beforeAll, expect, test } from "bun:test";
import type { LiveViewer } from "@k2b/cloud/events";
import type { RequestActor } from "@k2b/cloud/server";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { sql } from "bun";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { getMailboxPermission } from "../service/access";
import { mailLiveChannels } from "../service/live-channels";
import api from ".";

// Delivery and the session checks of the socket are covered by the platform's live
// routes test; this file checks that the Mail channel admits exactly the readers the
// Mail API admits. Sessions need Core's identity authority, which this process does
// not run, so people are checked against the API's own decision and API keys over the socket.
const suite = suiteFor("database", "nats", "valkey");
const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;

let server: ReturnType<typeof Bun.serve> | null = null;
const users: string[] = [];
const groups: string[] = [];
const mailboxes: string[] = [];
const accounts: string[] = [];
const grants: string[] = [];

beforeAll(async () => {
  if (!testInfra.database || !testInfra.nats || !testInfra.valkey) return;
  await migrate();
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: new Hono().route("/api/mail", api).fetch, websocket });
});

afterAll(async () => {
  await server?.stop(true);
  if (mailboxes.length > 0) await sql`DELETE FROM mail.mailboxes WHERE id IN ${sql(mailboxes)}`;
  if (grants.length > 0) await sql`DELETE FROM auth.access WHERE id IN ${sql(grants)}`;
  if (accounts.length > 0) await sql`DELETE FROM auth.service_accounts WHERE id IN ${sql(accounts)}`;
  if (groups.length > 0) await sql`DELETE FROM auth.groups WHERE id IN ${sql(groups)}`;
  if (users.length > 0) await sql`DELETE FROM auth.users WHERE id IN ${sql(users)}`;
});

const mailbox = async (name: string) => {
  const id = crypto.randomUUID();
  const shortId = newShortId();
  await sql`INSERT INTO mail.mailboxes (id, short_id, name) VALUES (${id}::uuid, ${shortId}, ${name})`;
  mailboxes.push(id);
  return { id, shortId };
};

type Grantee = { user_id: string } | { group_id: string } | { service_account_id: string } | { authenticated_only: true };

const grant = async (mailboxId: string, grantee: Grantee) => {
  const [access] =
    "user_id" in grantee
      ? await sql<{ id: string }[]>`INSERT INTO auth.access (user_id, permission) VALUES (${grantee.user_id}::uuid, 'read') RETURNING id`
      : "group_id" in grantee
        ? await sql<
            { id: string }[]
          >`INSERT INTO auth.access (group_id, permission) VALUES (${grantee.group_id}::uuid, 'read') RETURNING id`
        : "service_account_id" in grantee
          ? await sql<{ id: string }[]>`
              INSERT INTO auth.access (service_account_id, permission) VALUES (${grantee.service_account_id}::uuid, 'read') RETURNING id`
          : await sql<{ id: string }[]>`INSERT INTO auth.access (authenticated_only, permission) VALUES (true, 'read') RETURNING id`;
  grants.push(access!.id);
  await sql`INSERT INTO mail.mailbox_access (mailbox_id, access_id) VALUES (${mailboxId}::uuid, ${access!.id}::uuid)`;
};

/** A person as a request sees them: `roles` from the session; a phone's app session never holds `admin`. */
const person = async (name: string, roles: string[] = ["user"]): Promise<LiveViewer & { userId: string }> => {
  const id = crypto.randomUUID();
  await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name, admin)
    VALUES (${id}::uuid, ${`mail-live-${id}`}, 'local', 'user', ${name}, ${roles.includes("admin")})`;
  users.push(id);
  const actor = { kind: "user", user: { id, uid: `mail-live-${id}`, roles, displayName: name } } as unknown as RequestActor;
  return { id: `user:${id}`, userId: id, actor, accessSubject: { type: "user", userId: id }, scopes: [] };
};

/** A service account and an API key with `scopes`; a bound account belongs to `boundTo`. */
const keyFor = async (scopes: string[], boundTo?: string) => {
  const name = `Mail live ${newShortId()}`;
  const [created] = boundTo
    ? await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
        VALUES (${name}, 'resource_bound', 'mail', 'mailbox', ${boundTo}) RETURNING id`
    : await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind) VALUES (${name}, 'standalone') RETURNING id`;
  accounts.push(created!.id);
  return { id: created!.id, headers: await headersFor(created!.id, scopes) };
};

const headersFor = async (serviceAccountId: string, scopes: string[]) => {
  const key = await serviceAccountCredentials.createApiToken({ serviceAccountId, name: "live", scopes });
  if (!key.ok) throw new Error(key.error.message);
  return { authorization: `Bearer ${key.data.token}`, "x-forwarded-for": uniqueCallerAddress() };
};

/** Opens the Mail live socket, sends one subscription, and returns its first answer. */
const firstAnswer = async (headers: Record<string, string>, scope: unknown) => {
  const socket = new BunWebSocket(`ws://127.0.0.1:${server?.port}/api/mail/live`, { headers });
  try {
    return await new Promise<{ t: string; id?: string; code?: string }>((resolve, reject) => {
      socket.onopen = () => socket.send(JSON.stringify({ t: "sub", id: "m", channel: "mailbox", scope }));
      socket.onmessage = (message) => {
        const frame = JSON.parse(String(message.data)) as { t: string; id?: string; code?: string };
        if (frame.t !== "progress") resolve(frame);
      };
      socket.onerror = () => reject(new Error("The Mail live socket failed"));
    });
  } finally {
    socket.close();
  }
};

const notFound = { t: "revoked", id: "m", code: "not_found" };

suite("Mail live channel", () => {
  test("the channel admits exactly the people the Mail API lets read a mailbox", async () => {
    const shared = await mailbox("Live shared");
    const everyone = await mailbox("Live everyone");
    const deleted = await mailbox("Live deleted");
    const reader = await person("Ada Example");
    const member = await person("Bob Example");
    const stranger = await person("Cleo Example");
    // A global role grants no mailbox.
    const admin = await person("Dana Admin", ["user", "admin"]);
    const groupName = `mail-live-${newShortId()}`;
    const [group] = await sql<{ id: string }[]>`
      INSERT INTO auth.groups (cn, provider, name) VALUES (${groupName}, 'local', ${groupName}) RETURNING id`;
    groups.push(group!.id);
    await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${member.userId}::uuid, ${group!.id}::uuid)`;
    await grant(shared.id, { user_id: reader.userId });
    await grant(shared.id, { group_id: group!.id });
    await grant(everyone.id, { authenticated_only: true });
    await grant(deleted.id, { user_id: reader.userId });
    await sql`UPDATE mail.mailboxes SET deleted_at = now() WHERE id = ${deleted.id}::uuid`;

    const viewers = [reader, member, stranger, admin];
    for (const target of [shared, everyone, deleted]) {
      const admitted = await mailLiveChannels.mailbox.authorize(target.id, viewers);
      const allowedByApi = new Set<string>();
      for (const viewer of viewers) {
        const permission = await getMailboxPermission({ actor: viewer.actor, accessSubject: viewer.accessSubject }, target.id);
        if (permission !== "none") allowedByApi.add(viewer.id);
      }
      expect([...admitted].sort()).toEqual([...allowedByApi].sort());
    }
    expect([...(await mailLiveChannels.mailbox.authorize(shared.id, viewers))].sort()).toEqual([reader.id, member.id].sort());
    expect(await mailLiveChannels.mailbox.keys({ mailbox: "Zz9999" }, reader)).toBeNull();
  });

  test("API keys read on the socket what their binding and scopes let them read on the API", async () => {
    const own = await mailbox("Live bound");
    const other = await mailbox("Live other");
    // A mailbox key reads its own mailbox and nothing else, even with a grant on another.
    const bound = await keyFor(["read"], own.id);
    await grant(own.id, { service_account_id: bound.id });
    await grant(other.id, { service_account_id: bound.id });
    expect((await api.request(`/mailboxes/${own.shortId}`, { headers: bound.headers })).status).toBe(200);
    expect((await api.request(`/mailboxes/${other.shortId}`, { headers: bound.headers })).status).not.toBe(200);
    expect(await firstAnswer(bound.headers, { mailbox: own.shortId })).toMatchObject({ t: "ready" });
    expect(await firstAnswer(bound.headers, { mailbox: other.shortId })).toEqual(notFound);
    expect(await firstAnswer(bound.headers, { mailbox: "Zz9999" })).toEqual(notFound);

    // A standalone account with a grant: only its key with the read scope may read.
    const reader = await keyFor(["read"]);
    await grant(own.id, { service_account_id: reader.id });
    const unscoped = await headersFor(reader.id, []);
    expect((await api.request(`/mailboxes/${own.shortId}`, { headers: reader.headers })).status).toBe(200);
    expect((await api.request(`/mailboxes/${own.shortId}`, { headers: unscoped })).status).not.toBe(200);
    // Asked right after the allowed key, inside the 2-second decision cache.
    expect(await firstAnswer(reader.headers, { mailbox: own.shortId })).toMatchObject({ t: "ready" });
    expect(await firstAnswer(unscoped, { mailbox: own.shortId })).toEqual(notFound);
  });

  test("a tab from before the move to /live is told to sign in again, which reloads it once", async () => {
    const socket = new BunWebSocket(`ws://127.0.0.1:${server?.port}/api/mail/ws`, {
      headers: { "x-forwarded-for": uniqueCallerAddress() },
    });
    const closed = await new Promise<{ code: number; reason: string }>((resolve) => {
      socket.onclose = (event) => resolve({ code: event.code, reason: event.reason });
    });
    expect(closed).toEqual({ code: 1008, reason: "login_required" });
  });
});
