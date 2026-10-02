import { expect, setDefaultTimeout, test } from "bun:test";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { NOTE_DELETE_ADMIN_ONLY } from "../lib/note-delete-permission";
import { notebooksService } from "../service";
import notebooksApi from ".";

const suite = databaseSuite();
setDefaultTimeout(30_000);

const shortId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 6);

const grant = async (notebookId: string, principal: { userId: string } | { serviceAccountId: string }, permission: "write" | "admin") => {
  const [access] =
    "userId" in principal
      ? await sql<
          { id: string }[]
        >`INSERT INTO auth.access (user_id, permission) VALUES (${principal.userId}::uuid, ${permission}) RETURNING id`
      : await sql<{ id: string }[]>`
          INSERT INTO auth.access (service_account_id, permission) VALUES (${principal.serviceAccountId}::uuid, ${permission}) RETURNING id`;
  await sql`INSERT INTO notebooks.notebook_access (notebook_id, access_id) VALUES (${notebookId}::uuid, ${access!.id}::uuid)`;
};

/** Calls the real Notebooks API with a credential of the given service account. */
const apiAs = async (serviceAccountId: string, scopes: string[]) => {
  const created = await serviceAccountCredentials.createApiToken({ serviceAccountId, name: `test ${scopes.join(" ")}`, scopes });
  if (!created.ok) throw new Error(created.error.message);
  const authorization = `Bearer ${created.data.token}`;
  return (path: string, init?: { method?: string; body?: unknown; locale?: string }) =>
    notebooksApi.request(path, {
      method: init?.method ?? "GET",
      headers: {
        authorization,
        ...(init?.locale ? { "accept-language": init.locale } : {}),
        ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
};

suite("Notebooks note deletion rule", () => {
  test("admins can reserve deleting notes for themselves; writers and agents with write still edit but cannot delete", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const notebook = { id: crypto.randomUUID(), shortId: shortId() };
    await sql`INSERT INTO notebooks.notebooks (id, short_id, name) VALUES (${notebook.id}::uuid, ${notebook.shortId}, ${`Delete rule ${suffix}`})`;
    const userIds: string[] = [];
    const accountIds: string[] = [];
    try {
      const users = await sql<{ id: string }[]>`
        INSERT INTO auth.users (uid, provider, profile)
        VALUES (${`delete-admin-${suffix}`}, 'local', 'user'), (${`delete-writer-${suffix}`}, 'local', 'user')
        RETURNING id`;
      const [admin, writer] = users.map((row) => row.id) as [string, string];
      userIds.push(admin, writer);
      // A user-delegated key acts as its person, so these calls carry exactly the person's notebook permission.
      const delegated = await sql<{ id: string }[]>`
        INSERT INTO auth.service_accounts (name, kind, delegated_user_id)
        VALUES (${`Admin key ${suffix}`}, 'user_delegated', ${admin}::uuid), (${`Writer key ${suffix}`}, 'user_delegated', ${writer}::uuid)
        RETURNING id`;
      const [agent] = await sql<{ id: string }[]>`
        INSERT INTO auth.service_accounts (name, kind) VALUES (${`Agent ${suffix}`}, 'agent') RETURNING id`;
      accountIds.push(...delegated.map((row) => row.id), agent!.id);
      await grant(notebook.id, { userId: admin }, "admin");
      await grant(notebook.id, { userId: writer }, "write");
      await grant(notebook.id, { serviceAccountId: agent!.id }, "write");

      const asAdmin = await apiAs(delegated[0]!.id, ["openid", "read", "write", "admin"]);
      const asWriter = await apiAs(delegated[1]!.id, ["openid", "read", "write", "admin"]);
      const asAgent = await apiAs(agent!.id, ["openid", "read", "write"]);

      const createNote = async (title: string) => {
        const created = await notebooksService.note.create({
          data: { notebookId: notebook.id, contentMd: `# ${title}\n\nfirst\n` },
          creatorId: null,
        });
        if (!created.ok) throw new Error(created.error);
        return `/${notebook.shortId}/notes/${created.data.shortId}`;
      };

      // By default everyone who can write deletes notes, as before.
      expect(await (await asWriter(`/${notebook.shortId}`)).json()).toMatchObject({ noteDeletePermission: "write" });
      expect((await asWriter(await createNote("Writer default"), { method: "DELETE" })).status).toBe(200);
      expect((await asAgent(await createNote("Agent default"), { method: "DELETE" })).status).toBe(200);

      // Only admins choose the rule.
      expect((await asWriter(`/${notebook.shortId}`, { method: "PATCH", body: { noteDeletePermission: "admin" } })).status).toBe(403);
      const reserved = await asAdmin(`/${notebook.shortId}`, { method: "PATCH", body: { noteDeletePermission: "admin" } });
      expect(reserved.status).toBe(200);
      expect(await reserved.json()).toMatchObject({ noteDeletePermission: "admin" });

      const notePath = await createNote("Plan");
      const writerDelete = await asWriter(notePath, { method: "DELETE" });
      expect(writerDelete.status).toBe(403);
      expect(await writerDelete.json()).toEqual({
        code: NOTE_DELETE_ADMIN_ONLY,
        message: "Deleting notes is reserved for admins in this notebook.",
      });
      const agentDelete = await asAgent(notePath, { method: "DELETE", locale: "de" });
      expect(agentDelete.status).toBe(403);
      expect(await agentDelete.json()).toEqual({
        code: NOTE_DELETE_ADMIN_ONLY,
        message: "Löschen ist in diesem Notizbuch Admins vorbehalten.",
      });

      // Editing, including removing content, stays open to writers and agents.
      for (const call of [asWriter, asAgent]) {
        const edited = await call(`${notePath}/content`, {
          method: "PATCH",
          body: { operations: [{ kind: "delete-lines", startLine: 3, endLine: 3 }] },
        });
        expect(edited.status).toBe(200);
        await call(`${notePath}/content`, { method: "PATCH", body: { operations: [{ kind: "append", content: "again\n" }] } });
      }
      expect((await asWriter(`${notePath}/content`)).status).toBe(200);

      // Admins still delete; a missing note stays a 404, not the rule.
      expect((await asAdmin(notePath, { method: "DELETE" })).status).toBe(200);
      expect((await asAdmin(notePath, { method: "DELETE" })).status).toBe(404);

      // The service enforces the rule for every caller, not only this route.
      const direct = await notebooksService.note.getByShortId({ shortId: (await createNote("Direct")).split("/").at(-1)! });
      const denied = await notebooksService.note.remove({ id: direct!.id, permission: "write" });
      expect(denied.ok ? null : denied.error.code).toBe(NOTE_DELETE_ADMIN_ONLY);
      // Below write permission the answer is plain access denied, not the admin-only rule.
      const readOnly = await notebooksService.note.remove({ id: direct!.id, permission: "read" });
      expect(readOnly.ok ? null : readOnly.error.code).toBe("FORBIDDEN");
      expect(await notebooksService.note.get({ id: direct!.id })).not.toBeNull();
      expect((await notebooksService.note.remove({ id: direct!.id, permission: "admin" })).ok).toBe(true);

      // Switching back restores deleting for writers.
      expect((await asAdmin(`/${notebook.shortId}`, { method: "PATCH", body: { noteDeletePermission: "write" } })).status).toBe(200);
      expect((await asWriter(await createNote("Writer again"), { method: "DELETE" })).status).toBe(200);
    } finally {
      await sql`DELETE FROM notebooks.notebooks WHERE id = ${notebook.id}::uuid`;
      for (const id of accountIds) {
        await sql`DELETE FROM auth.service_account_credentials WHERE service_account_id = ${id}::uuid`;
        await sql`DELETE FROM auth.access WHERE service_account_id = ${id}::uuid`;
        await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
      }
      for (const id of userIds) {
        await sql`DELETE FROM auth.access WHERE user_id = ${id}::uuid`;
        await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
      }
    }
  });

  test("a writer's update that read the notebook before an admin reserved deleting keeps the admin's rule", async () => {
    const notebook = { id: crypto.randomUUID(), shortId: shortId() };
    await sql`INSERT INTO notebooks.notebooks (id, short_id, name) VALUES (${notebook.id}::uuid, ${notebook.shortId}, 'Before')`;
    // The admin's change holds the row lock, so the writer's rename reads the old rule and waits to write.
    const admin = await sql.reserve();
    let open = true;
    const finish = async (statement: "COMMIT" | "ROLLBACK") => {
      if (!open) return;
      open = false;
      try {
        await (statement === "COMMIT" ? admin`COMMIT` : admin`ROLLBACK`);
      } finally {
        admin.release();
      }
    };
    try {
      await admin`BEGIN`;
      const [backend] = await admin<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
      await admin`UPDATE notebooks.notebooks SET note_delete_permission = 'admin' WHERE id = ${notebook.id}::uuid`;
      const renamed = notebooksService.notebook.update({
        id: notebook.id,
        data: { name: "Renamed" },
        dateConfig: { timeZone: "UTC", locale: "en", firstDayOfWeek: 1 },
      });
      const deadline = Date.now() + 2_000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const [row] = await sql<{ waiting: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${backend!.pid}::int = ANY(pg_blocking_pids(pid))) AS waiting`;
        waiting = row?.waiting ?? false;
        if (!waiting) await Bun.sleep(10);
      }
      expect(waiting).toBe(true);
      await finish("COMMIT");
      expect(await renamed).toMatchObject({ ok: true, data: { name: "Renamed", noteDeletePermission: "admin" } });
      const [stored] = await sql<{ name: string; note_delete_permission: string }[]>`
        SELECT name, note_delete_permission FROM notebooks.notebooks WHERE id = ${notebook.id}::uuid`;
      expect(stored).toEqual({ name: "Renamed", note_delete_permission: "admin" });
    } finally {
      await finish("ROLLBACK");
      await sql`DELETE FROM notebooks.notebooks WHERE id = ${notebook.id}::uuid`;
    }
  });
});
