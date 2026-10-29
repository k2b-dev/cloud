import { expect, setDefaultTimeout, test } from "bun:test";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { databaseSuite, suiteFor } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import "../../../../scripts/fixtures/authorization-preload";
import { notebooksService } from "../service";
import { listNotebookAccess } from "../service/access";
import notebooksApi from ".";

const suite = databaseSuite();
setDefaultTimeout(30_000);

const insertAccount = async (name: string, notebookId?: string) => {
  const [row] = notebookId
    ? await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
        VALUES (${name}, 'resource_bound', 'notebooks', 'notebook', ${notebookId}) RETURNING id`
    : await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind) VALUES (${name}, 'agent') RETURNING id`;
  return { id: row!.id, name };
};

const grant = async (notebookId: string, serviceAccountId: string, permission: "read" | "write" | "admin") => {
  const [access] = await sql<{ id: string }[]>`
    INSERT INTO auth.access (service_account_id, permission) VALUES (${serviceAccountId}::uuid, ${permission}) RETURNING id`;
  await sql`INSERT INTO notebooks.notebook_access (notebook_id, access_id) VALUES (${notebookId}::uuid, ${access!.id}::uuid)`;
  return access!.id;
};

/** Calls the real Notebooks API with a service-account credential carrying the given scopes. */
const apiAs = async (account: { id: string }, scopes: string[]) => {
  const created = await serviceAccountCredentials.createApiToken({
    serviceAccountId: account.id,
    name: `test ${scopes.join(" ")}`,
    scopes,
  });
  if (!created.ok) throw new Error(created.error.message);
  const authorization = `Bearer ${created.data.token}`;
  return (path: string, init?: { method?: string; body?: unknown }) =>
    notebooksApi.request(path, {
      method: init?.method ?? "GET",
      headers: { authorization, ...(init?.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
};

const listedIds = async (response: Response) => ((await response.json()) as { data: { id: string }[] }).data.map((notebook) => notebook.id);

suite("Notebooks REST access for standalone agents", () => {
  test("an agent reads and writes only inside its direct grant and within its scopes; resource-bound keys stay bound", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const granted = { id: crypto.randomUUID(), shortId: testShortId() };
    const other = { id: crypto.randomUUID(), shortId: testShortId() };
    await sql`INSERT INTO notebooks.notebooks (id, short_id, name) VALUES
      (${granted.id}::uuid, ${granted.shortId}, ${`Agent granted ${suffix}`}), (${other.id}::uuid, ${other.shortId}, ${`Agent other ${suffix}`})`;
    const accountIds: string[] = [];
    try {
      const note = await notebooksService.note.create({
        data: { notebookId: granted.id, contentMd: "# Plan\n\nfirst\n" },
        creatorId: null,
      });
      if (!note.ok) throw new Error(note.error);
      const notePath = `/${granted.shortId}/notes/${note.data.shortId}`;

      const agent = await insertAccount(`Agent ${suffix}`);
      const stranger = await insertAccount(`Stranger ${suffix}`);
      const bound = await insertAccount(`Bound ${suffix}`, granted.id);
      accountIds.push(agent.id, stranger.id, bound.id);
      await grant(granted.id, agent.id, "write");
      await grant(granted.id, bound.id, "read");
      const otherBoundAccessId = await grant(other.id, bound.id, "admin");

      // Access entries name the service-account kind, so `access list` can show agents and hide resource API keys.
      const kinds = new Map((await listNotebookAccess(granted.id)).map((entry) => [entry.displayName, entry.serviceAccountKind]));
      expect(kinds).toEqual(
        new Map([
          [agent.name, "agent"],
          [bound.name, "resource_bound"],
        ]),
      );

      const call = await apiAs(agent, ["openid", "read", "write"]);
      const listed = await call("/");
      expect(listed.status).toBe(200);
      expect(await listedIds(listed)).toEqual([granted.shortId]);
      const read = await call(`${notePath}/content`);
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({ contentMd: "# Plan\n\nfirst\n" });
      expect((await call(`/${other.shortId}`)).status).toBe(403);

      const edited = await call(`${notePath}/content`, {
        method: "PATCH",
        body: { operations: [{ kind: "append", content: "from agent\n" }] },
      });
      expect(edited.status).toBe(200);
      expect(await (await call(`${notePath}/content`)).json()).toMatchObject({ contentMd: "# Plan\n\nfirst\nfrom agent\n" });
      const createdNote = await call(`/${granted.shortId}/notes`, { method: "POST", body: { contentMd: "# Agent notes\n" } });
      expect(createdNote.status).toBe(200);

      // Scopes cap the grant: a read-only token reads but cannot write.
      const readOnly = await apiAs(agent, ["read"]);
      expect((await readOnly(`${notePath}/content`)).status).toBe(200);
      expect(
        (await readOnly(`${notePath}/content`, { method: "PATCH", body: { operations: [{ kind: "append", content: "no\n" }] } })).status,
      ).toBe(403);
      expect((await (await apiAs(agent, ["openid"]))("/")).status).toBe(403);

      // Without a grant an agent sees nothing and cannot act.
      const denied = await apiAs(stranger, ["read", "write"]);
      expect(await listedIds(await denied("/"))).toEqual([]);
      expect((await denied(`${notePath}/content`)).status).toBe(403);
      expect(
        (await denied(`${notePath}/content`, { method: "PATCH", body: { operations: [{ kind: "append", content: "no\n" }] } })).status,
      ).toBe(403);

      // A resource-bound key keeps seeing only its bound Notebook, even with a grant elsewhere.
      const boundCall = await apiAs(bound, ["read"]);
      expect(await listedIds(await boundCall("/"))).toEqual([granted.shortId]);
      const graphResponse = await boundCall(`/${granted.shortId}/graph`);
      expect(graphResponse.status).toBe(200);
      const graph = (await graphResponse.json()) as { data: { nodes: Record<string, unknown>[]; edges: unknown[] } };
      const node = graph.data.nodes[0]!;
      expect(Object.keys(node).sort()).toEqual(["id", "inDegree", "parentId", "position", "title", "updatedAt"]);
      expect(node.id).toBe(note.data.shortId);
      expect(typeof node.title).toBe("string");
      expect(typeof node.inDegree).toBe("number");
      expect(node.parentId).toBeNull();
      expect(typeof node.position).toBe("number");
      expect(Number.isInteger(node.position)).toBe(true);
      expect(node.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(Array.isArray(graph.data.edges)).toBe(true);
      expect((await boundCall(`/${other.shortId}`)).status).toBe(403);
      const boundManager = await apiAs(bound, ["admin"]);
      const otherAccessPath = `/${other.shortId}/access`;
      expect((await boundManager(otherAccessPath)).status).toBe(403);
      expect(
        (await boundManager(otherAccessPath, { method: "POST", body: { principal: { type: "authenticated" }, permission: "read" } }))
          .status,
      ).toBe(403);
      expect(
        (await boundManager(`${otherAccessPath}/${otherBoundAccessId}`, { method: "PATCH", body: { permission: "read" } })).status,
      ).toBe(403);
      expect((await boundManager(`${otherAccessPath}/${otherBoundAccessId}`, { method: "DELETE" })).status).toBe(403);
    } finally {
      await sql`DELETE FROM notebooks.notebooks WHERE id IN (${granted.id}::uuid, ${other.id}::uuid)`;
      for (const id of accountIds) {
        await sql`DELETE FROM auth.service_account_credentials WHERE service_account_id = ${id}::uuid`;
        await sql`DELETE FROM auth.access WHERE service_account_id = ${id}::uuid`;
        await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
      }
    }
  });
});

const credentialSuite = suiteFor("database", "nats", "valkey");
credentialSuite("Notebook sharing with named machine principals", () => {
  for (const kind of ["standalone", "agent"] as const) {
    test(`${kind}: manage sharing, keep a manager, use the token, and revoke`, async () => {
      const suffix = crypto.randomUUID();
      const [owner] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name)
        VALUES (${`sharing-owner-${suffix}`}, 'local', 'user', 'Mara Lind') RETURNING id`;
      const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind)
        VALUES (${`Notebook helper ${suffix}`}, ${kind}) RETURNING id`;
      const notebook = { id: crypto.randomUUID(), shortId: testShortId() };
      const grants: string[] = [];
      try {
        await sql`INSERT INTO notebooks.notebooks (id, short_id, name)
          VALUES (${notebook.id}::uuid, ${notebook.shortId}, 'Shared research')`;
        const [manager] = await sql<{ id: string }[]>`INSERT INTO auth.access (user_id, permission)
          VALUES (${owner!.id}::uuid, 'admin') RETURNING id`;
        grants.push(manager!.id);
        await sql`INSERT INTO notebooks.notebook_access (notebook_id, access_id)
          VALUES (${notebook.id}::uuid, ${manager!.id}::uuid)`;
        const cookie = `session_token=${await createTestSession(owner!.id)}`;
        const sharing = (path: string, method = "GET", body?: unknown) =>
          notebooksApi.request(path, {
            method,
            headers: { cookie, "x-forwarded-for": uniqueCallerAddress(), "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
        const machine = await apiAs(account!, ["read", "write", "admin"]);
        expect((await machine(`/${notebook.shortId}`)).status).toBe(403);
        const created = await sharing(`/${notebook.shortId}/access`, "POST", {
          principal: { type: "service_account", serviceAccountId: account!.id },
          permission: "admin",
        });
        expect(created.status).toBe(200);
        const entry = await created.json();
        expect(entry).toMatchObject({
          principal: { type: "service_account", serviceAccountId: account!.id },
          displayName: `Notebook helper ${suffix}`,
          serviceAccountKind: kind,
          permission: "admin",
        });
        grants.push(entry.id);
        const listed = await sharing(`/${notebook.shortId}/access`);
        expect(listed.status).toBe(200);
        expect(await listed.json()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: entry.id,
              displayName: `Notebook helper ${suffix}`,
              serviceAccountKind: kind,
            }),
          ]),
        );
        expect((await machine(`/${notebook.shortId}`)).status).toBe(200);
        expect((await machine(`/${notebook.shortId}/notes`, { method: "POST", body: { contentMd: "# Shared result" } })).status).toBe(200);
        const readOnly = await apiAs(account!, ["read"]);
        expect((await readOnly(`/${notebook.shortId}/notes`, { method: "POST", body: { contentMd: "# Refused" } })).status).toBe(403);
        const accessPath = `/${notebook.shortId}/access`;
        const machineList = await machine(accessPath);
        expect(machineList.status).toBe(200);
        expect(await machineList.json()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: entry.id, displayName: `Notebook helper ${suffix}`, serviceAccountKind: kind }),
          ]),
        );
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
        // A human may hand management to either kind of independent machine principal.
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
        expect((await sharing(`/${notebook.shortId}/access/${entry.id}`, "DELETE")).status).toBe(200);
        expect((await machine(`/${notebook.shortId}`)).status).toBe(403);
        expect((await machine(`/${notebook.shortId}/notes`, { method: "POST", body: { contentMd: "# Refused" } })).status).toBe(403);
      } finally {
        await sql`DELETE FROM notebooks.notebooks WHERE id = ${notebook.id}::uuid`;
        for (const id of grants) await sql`DELETE FROM auth.access WHERE id = ${id}::uuid`;
        await sql`DELETE FROM auth.service_accounts WHERE id = ${account!.id}::uuid`;
        await sql`DELETE FROM auth.users WHERE id = ${owner!.id}::uuid`;
      }
    });
  }
});
