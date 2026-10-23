import { expect, setDefaultTimeout, test } from "bun:test";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { databaseSuite, suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { newShortId } from "../lib/short-id";
import spacesApi from ".";

const suite = databaseSuite();
setDefaultTimeout(30_000);

const insertAccount = async (name: string, spaceId?: string) => {
  const [row] = spaceId
    ? await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
        VALUES (${name}, 'resource_bound', 'spaces', 'space', ${spaceId}) RETURNING id`
    : await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind) VALUES (${name}, 'agent') RETURNING id`;
  return { id: row!.id, name };
};

const grant = async (spaceId: string, serviceAccountId: string, permission: "read" | "write" | "admin") => {
  const [access] = await sql<{ id: string }[]>`
    INSERT INTO auth.access (service_account_id, permission) VALUES (${serviceAccountId}::uuid, ${permission}) RETURNING id`;
  await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${spaceId}::uuid, ${access!.id}::uuid)`;
  return access!.id;
};

/** Calls the real Spaces API with a service-account credential carrying the given scopes. */
const apiAs = async (account: { id: string }, scopes: string[]) => {
  const created = await serviceAccountCredentials.createApiToken({
    serviceAccountId: account.id,
    name: `test ${scopes.join(" ")}`,
    scopes,
  });
  if (!created.ok) throw new Error(created.error.message);
  const authorization = `Bearer ${created.data.token}`;
  return (path: string, init?: { method?: string; body?: unknown }) =>
    spacesApi.request(path, {
      method: init?.method ?? "GET",
      headers: { authorization, ...(init?.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
};

suite("Spaces REST access for standalone agents", () => {
  test("an agent works only inside its direct grant and within its scopes; resource-bound keys stay bound", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const spaces = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO spaces.spaces (short_id, name) VALUES (${newShortId()}, ${`Agent granted ${suffix}`}), (${newShortId()}, ${`Agent other ${suffix}`})
      RETURNING id, short_id`;
    const [granted, other] = spaces as [(typeof spaces)[number], (typeof spaces)[number]];
    const accountIds: string[] = [];
    try {
      const [column] = await sql<{ id: string }[]>`INSERT INTO spaces.columns (short_id, space_id, name, rank, is_done)
        VALUES (${newShortId()}, ${granted.id}::uuid, 'Open', 1024, false) RETURNING id`;
      const [item] = await sql<{ short_id: string }[]>`INSERT INTO spaces.items (short_id, space_id, column_id, title)
        VALUES (${newShortId()}, ${granted.id}::uuid, ${column!.id}::uuid, 'Agent task') RETURNING short_id`;
      const itemPath = `/${granted.short_id}/items/${item!.short_id}`;

      const agent = await insertAccount(`Agent ${suffix}`);
      const stranger = await insertAccount(`Stranger ${suffix}`);
      const bound = await insertAccount(`Bound ${suffix}`, granted.id);
      accountIds.push(agent.id, stranger.id, bound.id);
      await grant(granted.id, agent.id, "write");
      await grant(granted.id, bound.id, "write");
      const otherBoundAccessId = await grant(other.id, bound.id, "admin");

      const call = await apiAs(agent, ["openid", "read", "write"]);
      const listed = await call("/");
      expect(listed.status).toBe(200);
      expect(((await listed.json()) as { id: string }[]).map((space) => space.id)).toEqual([granted.short_id]);
      expect((await call(`/items/${item!.short_id}`)).status).toBe(200);
      expect((await call(`/${other.short_id}`)).status).toBe(403);

      const claimId = crypto.randomUUID();
      const claimed = await call(`${itemPath}/claim`, { method: "POST", body: { claimId } });
      expect(claimed.status).toBe(200);
      expect(await claimed.json()).toMatchObject({ claim: { id: claimId, actor: { kind: "service_account", id: agent.id } } });
      const progressed = await call(`${itemPath}/progress`, { method: "POST", body: { claimId, content: "Halfway there." } });
      expect(progressed.status).toBe(200);

      const commented = await call(`${itemPath}/comments`, { method: "POST", body: { content: "Picked this up." } });
      expect(commented.status).toBe(200);
      expect(await commented.json()).toMatchObject({ userId: null, userName: agent.name, content: "Picked this up." });
      const page = (await (await call(`${itemPath}/comments/page`)).json()) as { items: { userName: string | null }[] };
      expect(page.items.map((comment) => comment.userName)).toEqual([agent.name]);

      // Scopes cap the grant: a read-only token reads but cannot write.
      const readOnly = await apiAs(agent, ["read"]);
      expect((await readOnly(`/items/${item!.short_id}`)).status).toBe(200);
      expect((await readOnly(`${itemPath}/comments`, { method: "POST", body: { content: "Denied" } })).status).toBe(403);
      expect((await readOnly(`${itemPath}/claim`, { method: "POST", body: { claimId: crypto.randomUUID() } })).status).toBe(403);
      expect((await (await apiAs(agent, ["openid"]))("/")).status).toBe(403);

      // Without a grant an agent sees nothing and cannot act.
      const denied = await apiAs(stranger, ["read", "write"]);
      expect(await (await denied("/")).json()).toEqual([]);
      expect((await denied(`/items/${item!.short_id}`)).status).toBe(404);
      expect((await denied(`${itemPath}/comments`, { method: "POST", body: { content: "Denied" } })).status).toBe(403);
      expect((await denied(`${itemPath}/claim`, { method: "POST", body: { claimId: crypto.randomUUID() } })).status).toBe(403);

      // A resource-bound key keeps seeing only its bound Space, even with a grant elsewhere, and still cannot comment.
      const boundCall = await apiAs(bound, ["read"]);
      expect(((await (await boundCall("/")).json()) as { id: string }[]).map((space) => space.id)).toEqual([granted.short_id]);
      expect((await boundCall(`/${other.short_id}`)).status).toBe(403);
      const boundManager = await apiAs(bound, ["admin"]);
      const otherAccessPath = `/${other.short_id}/access`;
      expect((await boundManager(otherAccessPath)).status).toBe(403);
      expect(
        (await boundManager(otherAccessPath, { method: "POST", body: { principal: { type: "authenticated" }, permission: "read" } }))
          .status,
      ).toBe(403);
      expect(
        (await boundManager(`${otherAccessPath}/${otherBoundAccessId}`, { method: "PATCH", body: { permission: "read" } })).status,
      ).toBe(403);
      expect((await boundManager(`${otherAccessPath}/${otherBoundAccessId}`, { method: "DELETE" })).status).toBe(403);

      expect(
        (await (await apiAs(bound, ["read", "write"]))(`${itemPath}/comments`, { method: "POST", body: { content: "No" } })).status,
      ).toBe(403);
    } finally {
      await sql`DELETE FROM spaces.spaces WHERE id IN (${granted.id}::uuid, ${other.id}::uuid)`;
      for (const id of accountIds) {
        await sql`DELETE FROM auth.service_account_credentials WHERE service_account_id = ${id}::uuid`;
        await sql`DELETE FROM auth.access WHERE service_account_id = ${id}::uuid`;
        await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
      }
    }
  });
});

const credentialSuite = suiteFor("database", "nats", "valkey");
credentialSuite("Space sharing with named machine principals", () => {
  for (const kind of ["standalone", "agent"] as const) {
    test(`${kind}: manage sharing, keep a manager, use the token, and revoke`, async () => {
      const suffix = crypto.randomUUID();
      const [owner] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name)
        VALUES (${`space-sharing-owner-${suffix}`}, 'local', 'user', 'Mara Lind') RETURNING id`;
      const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind)
        VALUES (${`Space helper ${suffix}`}, ${kind}) RETURNING id`;
      const [space] = await sql<{ id: string; short_id: string }[]>`INSERT INTO spaces.spaces (short_id, name)
        VALUES (${newShortId()}, 'Shared work') RETURNING id, short_id`;
      const grants: string[] = [];
      try {
        const [column] = await sql<{ id: string; short_id: string }[]>`INSERT INTO spaces.columns (short_id, space_id, name, rank)
          VALUES (${newShortId()}, ${space!.id}::uuid, 'Open', 1024) RETURNING id, short_id`;
        const [manager] = await sql<{ id: string }[]>`INSERT INTO auth.access (user_id, permission)
          VALUES (${owner!.id}::uuid, 'admin') RETURNING id`;
        grants.push(manager!.id);
        await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${space!.id}::uuid, ${manager!.id}::uuid)`;
        const cookie = `session_token=${await createTestSession(owner!.id)}`;
        const sharing = (path: string, method = "GET", body?: unknown) =>
          spacesApi.request(path, {
            method,
            headers: { cookie, "x-forwarded-for": uniqueCallerAddress(), "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
        const base = `/${space!.short_id}`;
        const accessPath = `${base}/access`;
        const machine = await apiAs(account!, ["read", "write", "admin"]);
        expect((await machine(base)).status).toBe(403);
        const created = await sharing(accessPath, "POST", {
          principal: { type: "service_account", serviceAccountId: account!.id },
          permission: "admin",
        });
        expect(created.status).toBe(200);
        const entry = await created.json();
        grants.push(entry.id);
        expect(entry).toMatchObject({
          principal: { type: "service_account", serviceAccountId: account!.id },
          displayName: `Space helper ${suffix}`,
          serviceAccountKind: kind,
          permission: "admin",
        });
        for (const call of [sharing, machine]) {
          const listed = await call(accessPath);
          expect(listed.status).toBe(200);
          expect(await listed.json()).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ id: entry.id, displayName: `Space helper ${suffix}`, serviceAccountKind: kind }),
            ]),
          );
        }
        expect((await machine(base)).status).toBe(200);
        const itemBody = { title: "Shared result", columnId: column!.short_id };
        expect((await machine(`${base}/items`, { method: "POST", body: itemBody })).status).toBe(200);
        const readOnly = await apiAs(account!, ["read"]);
        expect((await readOnly(base)).status).toBe(200);
        expect((await readOnly(`${base}/items`, { method: "POST", body: itemBody })).status).toBe(403);
        expect((await readOnly(accessPath)).status).toBe(403);
        expect(
          (await readOnly(accessPath, { method: "POST", body: { principal: { type: "authenticated" }, permission: "read" } })).status,
        ).toBe(403);
        expect((await readOnly(`${accessPath}/${entry.id}`, { method: "PATCH", body: { permission: "read" } })).status).toBe(403);
        expect((await readOnly(`${accessPath}/${entry.id}`, { method: "DELETE" })).status).toBe(403);
        const temporary = await machine(accessPath, { method: "POST", body: { principal: { type: "authenticated" }, permission: "read" } });
        expect(temporary.status).toBe(200);
        const temporaryEntry = await temporary.json();
        grants.push(temporaryEntry.id);
        expect((await machine(`${accessPath}/${temporaryEntry.id}`, { method: "PATCH", body: { permission: "write" } })).status).toBe(200);
        expect((await machine(`${accessPath}/${temporaryEntry.id}`, { method: "DELETE" })).status).toBe(200);
        expect((await sharing(`${accessPath}/${manager!.id}`, "PATCH", { permission: "read" })).status).toBe(200);
        for (const method of ["PATCH", "DELETE"]) {
          const refused = await machine(`${accessPath}/${entry.id}`, {
            method,
            ...(method === "PATCH" ? { body: { permission: "read" } } : {}),
          });
          expect(refused.status).toBe(409);
          expect(await refused.json()).toMatchObject({ code: "LAST_MANAGER" });
        }
        expect((await machine(`${accessPath}/${manager!.id}`, { method: "PATCH", body: { permission: "admin" } })).status).toBe(200);
        expect((await sharing(`${accessPath}/${entry.id}`, "DELETE")).status).toBe(200);
        expect((await machine(base)).status).toBe(403);
        expect((await machine(`${base}/items`, { method: "POST", body: itemBody })).status).toBe(403);
      } finally {
        await sql`DELETE FROM spaces.spaces WHERE id = ${space!.id}::uuid`;
        for (const id of grants) await sql`DELETE FROM auth.access WHERE id = ${id}::uuid`;
        await sql`DELETE FROM auth.service_accounts WHERE id = ${account!.id}::uuid`;
        await sql`DELETE FROM auth.users WHERE id = ${owner!.id}::uuid`;
      }
    });
  }
});
