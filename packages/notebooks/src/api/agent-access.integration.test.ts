import { expect, setDefaultTimeout, test } from "bun:test";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { notebooksService } from "../service";
import { listNotebookAccess } from "../service/access";
import notebooksApi from ".";

const suite = databaseSuite();
setDefaultTimeout(30_000);

const shortId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 6);

const insertAccount = async (name: string, notebookId?: string) => {
  const [row] = notebookId
    ? await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
        VALUES (${name}, 'resource_bound', 'notebooks', 'notebook', ${notebookId}) RETURNING id`
    : await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind) VALUES (${name}, 'agent') RETURNING id`;
  return { id: row!.id, name };
};

const grant = async (notebookId: string, serviceAccountId: string, permission: "read" | "write") => {
  const [access] = await sql<{ id: string }[]>`
    INSERT INTO auth.access (service_account_id, permission) VALUES (${serviceAccountId}::uuid, ${permission}) RETURNING id`;
  await sql`INSERT INTO notebooks.notebook_access (notebook_id, access_id) VALUES (${notebookId}::uuid, ${access!.id}::uuid)`;
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
    const granted = { id: crypto.randomUUID(), shortId: shortId() };
    const other = { id: crypto.randomUUID(), shortId: shortId() };
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
      await grant(other.id, bound.id, "read");

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
      expect((await boundCall(`/${other.shortId}`)).status).toBe(403);
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
