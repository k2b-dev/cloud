import { expect, setDefaultTimeout, test } from "bun:test";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { newShortId } from "../lib/short-id";
import pulseApi from ".";

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
  return (path: string, init?: { method?: string; body?: unknown }) =>
    pulseApi.request(path, {
      method: init?.method ?? "GET",
      headers: { authorization, ...(init?.body === undefined ? {} : { "content-type": "application/json" }) },
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
    const accountIds: string[] = [];
    try {
      const agent = await insertAccount(`Pulse agent ${suffix}`);
      const stranger = await insertAccount(`Pulse stranger ${suffix}`);
      const bound = await insertAccount(`Pulse bound ${suffix}`, granted.shortId);
      accountIds.push(agent.id, stranger.id, bound.id);
      await grant(granted.id, agent.id, "write");
      await grant(granted.id, bound.id, "read");
      await grant(other.id, bound.id, "read");

      // With a grant, an agent lists, reads, and changes the base like a person with the same grant.
      const call = await apiAs(agent, ["openid", "read", "write"]);
      const bases = await call("/bases");
      expect(bases.status).toBe(200);
      expect(await listedIds(bases)).toEqual([granted.shortId]);
      expect((await call(`/bases/${granted.shortId}`)).status).toBe(200);
      expect((await call(`/bases/${granted.shortId}/saved-queries`)).status).toBe(200);
      expect((await call(`/bases/${other.shortId}`)).status).toBe(403);
      const renamed = await call(`/bases/${granted.shortId}`, { method: "PATCH", body: { name: `Renamed ${suffix}` } });
      expect(renamed.status).toBe(200);
      expect(await renamed.json()).toMatchObject({ id: granted.shortId, name: `Renamed ${suffix}` });
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
