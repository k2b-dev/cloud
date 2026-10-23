import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { databaseSuite, suiteFor } from "../../../../scripts/fixtures/test-infra";
import { resolvePulseMessages } from "../messages";
import { seedActiveBaseStore } from "../service/base-store.test-fixture";
import { settingsFixture } from "../store/settings.test-fixture";
import "../../../../scripts/fixtures/authorization-preload";
import { newShortId } from "../lib/short-id";
import pulseApi from ".";

let settings: ReturnType<typeof settingsFixture> | undefined;
beforeAll(() => {
  settings = settingsFixture();
  settings.values["pulse.clickhouse_connection"] = JSON.stringify({
    url: "http://127.0.0.1:1",
    user: "fixture",
    password: "fixture-password",
  });
});
afterAll(() => settings?.restore());
const suite = databaseSuite();
setDefaultTimeout(30_000);

const insertAccount = async (name: string, baseShortId?: string) => {
  const [row] = baseShortId
    ? await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
        VALUES (${name}, 'resource_bound', 'pulse', 'pulse_base', ${baseShortId}) RETURNING id`
    : await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind) VALUES (${name}, 'agent') RETURNING id`;
  return { id: row!.id };
};

const grant = async (baseId: string, serviceAccountId: string, permission: "read" | "write" | "admin") => {
  const [access] = await sql<{ id: string }[]>`
    INSERT INTO auth.access (service_account_id, permission) VALUES (${serviceAccountId}::uuid, ${permission}) RETURNING id`;
  await sql`INSERT INTO pulse.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${access!.id}::uuid)`;
};

/** Calls the real Pulse API with a service-account credential carrying the given scopes. */
const apiAs = async (account: { id: string }, scopes: string[]) => {
  const created = await serviceAccountCredentials.createApiToken({
    serviceAccountId: account.id,
    name: `test ${scopes.join(" ")}`,
    scopes,
  });
  if (!created.ok) throw new Error(created.error.message);
  const authorization = `Bearer ${created.data.token}`;
  return (path: string, init?: { method?: string; body?: unknown; locale?: string }) =>
    pulseApi.request(path, {
      method: init?.method ?? "GET",
      headers: {
        authorization,
        ...(init?.locale ? { "accept-language": init.locale } : {}),
        ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
};

const listedIds = async (response: Response) => ((await response.json()) as { id: string }[]).map((base) => base.id);

suite("Pulse REST access for standalone agents", () => {
  test("an agent uses only its direct grant within its scopes; resource-bound keys stay bound", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const granted = { id: crypto.randomUUID(), shortId: newShortId() };
    const other = { id: crypto.randomUUID(), shortId: newShortId() };
    await sql`INSERT INTO pulse.bases (id, short_id, name) VALUES
      (${granted.id}::uuid, ${granted.shortId}, ${`Agent granted ${suffix}`}),
      (${other.id}::uuid, ${other.shortId}, ${`Agent other ${suffix}`})`;
    await seedActiveBaseStore(granted.id, other.id);
    const accountIds: string[] = [];
    try {
      const agent = await insertAccount(`Pulse agent ${suffix}`);
      const stranger = await insertAccount(`Pulse stranger ${suffix}`);
      const bound = await insertAccount(`Pulse bound ${suffix}`, granted.shortId);
      accountIds.push(agent.id, stranger.id, bound.id);
      await grant(granted.id, agent.id, "write");
      await grant(granted.id, bound.id, "read");
      await grant(other.id, bound.id, "read");

      // With a grant, an agent lists and reads the base like a person with the same grant.
      const call = await apiAs(agent, ["openid", "read", "write"]);
      const bases = await call("/bases");
      expect(bases.status).toBe(200);
      expect(await listedIds(bases)).toEqual([granted.shortId]);
      expect((await call(`/bases/${granted.shortId}`)).status).toBe(200);
      expect((await call(`/bases/${granted.shortId}/sources`)).status).toBe(200);
      expect((await call(`/bases/${other.shortId}`)).status).toBe(403);
      const renamed = await call(`/bases/${granted.shortId}`, { method: "PATCH", body: { name: `Renamed ${suffix}` } });
      expect(renamed.status).toBe(403);
      // General base settings require a base-admin grant, including for agents.
      // Managing access needs an `admin` grant.
      expect((await call(`/bases/${granted.shortId}/access`)).status).toBe(403);

      // Scopes cap the grant: a read-only token reads but cannot write, and a token without `read` reaches nothing.
      const readOnly = await apiAs(agent, ["read"]);
      expect((await readOnly(`/bases/${granted.shortId}`)).status).toBe(200);
      expect((await readOnly(`/bases/${granted.shortId}`, { method: "PATCH", body: { name: `No ${suffix}` } })).status).toBe(403);
      const unscoped = await apiAs(agent, ["openid"]);
      expect(await listedIds(await unscoped("/bases"))).toEqual([]);
      expect((await unscoped(`/bases/${granted.shortId}`)).status).toBe(403);

      // With an `admin` grant, managing access still needs a token with the `admin` scope.
      await sql`UPDATE auth.access SET permission = 'admin' WHERE service_account_id = ${agent.id}::uuid`;
      expect((await call(`/bases/${granted.shortId}/access`)).status).toBe(403);
      const manager = await apiAs(agent, ["read", "write", "admin"]);
      expect((await manager(`/bases/${granted.shortId}/access`)).status).toBe(200);

      // Without a grant an agent sees nothing and cannot act.
      const denied = await apiAs(stranger, ["read", "write"]);
      expect(await listedIds(await denied("/bases"))).toEqual([]);
      expect((await denied(`/bases/${granted.shortId}`)).status).toBe(403);
      expect((await denied(`/bases/${granted.shortId}`, { method: "PATCH", body: { name: `No ${suffix}` } })).status).toBe(403);

      // A resource-bound key keeps seeing only its bound base, even with a grant elsewhere.
      const boundCall = await apiAs(bound, ["read"]);
      expect(await listedIds(await boundCall("/bases"))).toEqual([granted.shortId]);
      expect((await boundCall(`/bases/${granted.shortId}`)).status).toBe(200);
      expect((await boundCall(`/bases/${other.shortId}`)).status).toBe(403);
    } finally {
      await sql`DELETE FROM pulse.bases WHERE id IN (${granted.id}::uuid, ${other.id}::uuid)`;
      for (const id of accountIds) {
        await sql`DELETE FROM auth.service_account_credentials WHERE service_account_id = ${id}::uuid`;
        await sql`DELETE FROM auth.access WHERE service_account_id = ${id}::uuid`;
        await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
      }
    }
  });
});

suite("Pulse source target policy at the REST boundary", () => {
  test("create and changed endpoints refuse internal targets; existing sources persist and scrape errors localize", async () => {
    const base = { id: crypto.randomUUID(), shortId: newShortId() };
    const source = { id: crypto.randomUUID(), shortId: newShortId() };
    const account = await insertAccount(`Pulse target policy ${base.id}`);
    try {
      await sql`INSERT INTO pulse.bases(id, short_id, name) VALUES(${base.id}::uuid, ${base.shortId}, 'Target policy')`;
      await seedActiveBaseStore(base.id);
      await grant(base.id, account.id, "write");
      const call = await apiAs(account, ["read", "write"]);
      const refused = { code: "PULSE_SCRAPE_TARGET_BLOCKED", message: `127.0.0.1 ${resolvePulseMessages("de").t.scrapeTargetBlocked}` };
      const root = `/bases/${base.shortId}/sources`;
      const created = await call(root, {
        method: "POST",
        locale: "de",
        body: { kind: "metrics", name: "Internal", endpointUrl: "http://127.0.0.1:1/metrics" },
      });
      expect(created.status).toBe(400);
      expect(await created.json()).toEqual(refused);
      const [count] = await sql`SELECT count(*)::int AS count FROM pulse.sources WHERE base_id=${base.id}::uuid`;
      expect(count.count).toBe(0);
      // Model an existing internal source; no migration or deletion is needed.
      await sql`INSERT INTO pulse.sources(id, short_id, base_id, kind, name, endpoint_url) VALUES(${source.id}::uuid, ${source.shortId}, ${base.id}::uuid, 'metrics', 'Existing internal', 'http://127.0.0.1:1/old')`;
      const changed = await call(`${root}/${source.shortId}`, {
        method: "PATCH",
        locale: "de",
        body: { endpointUrl: "http://127.0.0.2:1/new" },
      });
      expect(changed.status).toBe(400);
      expect(await changed.json()).toEqual({ ...refused, message: refused.message.replace("127.0.0.1", "127.0.0.2") });
      expect((await call(`${root}/${source.shortId}`, { method: "PATCH", body: { name: "Still editable" } })).status).toBe(200);
      const scraped = await call(`${root}/${source.shortId}/scrape`, { method: "POST", locale: "de" });
      expect(scraped.status).toBe(400);
      expect(await scraped.json()).toEqual(refused);
      const [row] = await sql`SELECT endpoint_url, last_error FROM pulse.sources WHERE id=${source.id}::uuid`;
      expect(row.endpoint_url).toBe("http://127.0.0.1:1/old");
      expect(row.last_error).toBe(`127.0.0.1 ${resolvePulseMessages("en").t.scrapeTargetBlocked}`);
      // An operator entry permits create/update; preflight sends no HTTP request.
      await sql`INSERT INTO pulse.base_internal_targets(base_id,entry) VALUES(${base.id}::uuid,'127.0.0.0/8')`;
      expect(
        (await call(root, { method: "POST", body: { kind: "metrics", name: "Allowed", endpointUrl: "http://127.0.0.1:1/metrics" } }))
          .status,
      ).toBe(201);
      expect((await call(`${root}/${source.shortId}`, { method: "PATCH", body: { endpointUrl: "http://127.0.0.2:1/new" } })).status).toBe(
        200,
      );
      await sql`DELETE FROM pulse.base_internal_targets WHERE base_id=${base.id}::uuid`;
      expect((await call(root, { method: "POST", body: { kind: "http_ingest", name: "Ingest" } })).status).toBe(201);
    } finally {
      await sql`DELETE FROM pulse.bases WHERE id=${base.id}::uuid`;
      await sql`DELETE FROM auth.service_account_credentials WHERE service_account_id=${account.id}::uuid`;
      await sql`DELETE FROM auth.access WHERE service_account_id=${account.id}::uuid`;
      await sql`DELETE FROM auth.service_accounts WHERE id=${account.id}::uuid`;
    }
  });
});

const sharingSuite = suiteFor("database", "nats", "valkey");
sharingSuite("pulse named machine grants at the REST boundary", () => {
  for (const kind of ["standalone", "agent"] as const) {
    test(`${kind}: grant, named entry, token read/write, and revoke`, async () => {
      const suffix = crypto.randomUUID();
      const [owner] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name)
        VALUES (${`pulse-parity-${suffix}`}, 'local', 'user', 'Mara Lind') RETURNING id`;
      const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind)
        VALUES (${`Research helper ${suffix}`}, ${kind}) RETURNING id`;
      const resource = { id: crypto.randomUUID(), shortId: newShortId() };
      try {
        await sql`INSERT INTO pulse.bases (id, short_id, name) VALUES (${resource.id}::uuid, ${resource.shortId}, 'Research')`;
        await seedActiveBaseStore(resource.id);
        const [ownerGrant] = await sql<{ id: string }[]>`INSERT INTO auth.access (user_id, permission)
          VALUES (${owner!.id}::uuid, 'admin') RETURNING id`;
        await sql`INSERT INTO pulse.base_access (base_id, access_id) VALUES (${resource.id}::uuid, ${ownerGrant!.id}::uuid)`;
        const cookie = `session_token=${await createTestSession(owner!.id)}`;
        const human = (path: string, method: string, body?: unknown) =>
          pulseApi.request(path, {
            method,
            headers: { cookie, "content-type": "application/json", "x-forwarded-for": uniqueCallerAddress() },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
        const resourcePath = `/bases/${resource.shortId}`;
        const accessPath = `${resourcePath}/access`;
        const machine = await apiAs(account!, ["admin"]);
        expect((await machine(resourcePath)).status).toBe(403);
        const response = await human(accessPath, "POST", {
          principal: { type: "service_account", serviceAccountId: account!.id },
          permission: "admin",
        });
        expect(response.status).toBe(201);
        const entry = await response.json();
        expect(entry).toMatchObject({ displayName: `Research helper ${suffix}`, serviceAccountKind: kind });
        expect((await machine(resourcePath)).status).toBe(200);
        const change = { method: "PATCH", body: { name: "Updated by helper" } };
        expect((await machine(resourcePath, change)).status).toBe(200);
        const readOnly = await apiAs(account!, ["read"]);
        expect((await readOnly(resourcePath)).status).toBe(200);
        expect((await readOnly(resourcePath, change)).status).toBe(403);
        expect((await human(`${accessPath}/${entry.id}`, "DELETE")).status).toBe(200);
        expect((await machine(resourcePath)).status).toBe(403);
        expect((await machine(resourcePath, change)).status).toBe(403);
      } finally {
        await sql`DELETE FROM auth.access WHERE id IN (SELECT access_id FROM pulse.base_access WHERE base_id=${resource.id}::uuid)`;
        await sql`DELETE FROM pulse.bases WHERE id=${resource.id}::uuid`;
        await sql`DELETE FROM auth.service_accounts WHERE id=${account!.id}::uuid`;
        await sql`DELETE FROM auth.users WHERE id=${owner!.id}::uuid`;
      }
    });
  }
});
