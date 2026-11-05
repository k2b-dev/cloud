import { expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import "../../../../scripts/fixtures/authorization-preload";
import { PAGE_TEMPLATE_LIMIT } from "../lib/page-templates";
import { notebooksService } from "../service";
import notebooksApi from ".";

const suite = databaseSuite();
setDefaultTimeout(30_000);

const grant = async (notebookId: string, principal: { userId: string } | { serviceAccountId: string }, permission: "read" | "write") => {
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

const newNotebook = async (name: string) => {
  const notebook = { id: crypto.randomUUID(), shortId: testShortId() };
  await sql`INSERT INTO notebooks.notebooks (id, short_id, name) VALUES (${notebook.id}::uuid, ${notebook.shortId}, ${name})`;
  return notebook;
};

suite("Notebooks page templates", () => {
  test("readers list a notebook's templates, writers save, use, rename and delete them, and nothing reaches another notebook", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const notebook = await newNotebook(`Templates ${suffix}`);
    const other = await newNotebook(`Other ${suffix}`);
    const userIds: string[] = [];
    const accountIds: string[] = [];
    try {
      const users = await sql<{ id: string }[]>`
        INSERT INTO auth.users (uid, provider, profile, display_name)
        VALUES (${`tpl-writer-${suffix}`}, 'local', 'user', 'Wanda Writer'), (${`tpl-reader-${suffix}`}, 'local', 'user', 'Rita Reader')
        RETURNING id`;
      const [writer, reader] = users.map((row) => row.id) as [string, string];
      userIds.push(writer, reader);
      // A user-delegated key acts as its person, so these calls carry exactly the person's notebook permission.
      const delegated = await sql<{ id: string }[]>`
        INSERT INTO auth.service_accounts (name, kind, delegated_user_id)
        VALUES (${`Writer key ${suffix}`}, 'user_delegated', ${writer}::uuid), (${`Reader key ${suffix}`}, 'user_delegated', ${reader}::uuid)
        RETURNING id`;
      accountIds.push(...delegated.map((row) => row.id));
      await grant(notebook.id, { userId: writer }, "write");
      await grant(notebook.id, { userId: reader }, "read");
      await grant(other.id, { userId: writer }, "write");
      const asWriter = await apiAs(delegated[0]!.id, ["openid", "read", "write"]);
      const asReader = await apiAs(delegated[1]!.id, ["openid", "read", "write"]);

      const page = await notebooksService.note.create({
        data: { notebookId: notebook.id, contentMd: "# Weekly {{date}}\n\n- **By:** {{author}}\n- {{ unknown }}\n" },
        creatorId: writer,
      });
      if (!page.ok) throw new Error(page.error);
      const foreignPage = await notebooksService.note.create({
        data: { notebookId: other.id, contentMd: "# Elsewhere\n" },
        creatorId: writer,
      });
      if (!foreignPage.ok) throw new Error(foreignPage.error);

      // Reading the notebook lists its built-in templates in the caller's language.
      const readerList = await asReader(`/${notebook.shortId}/page-templates`, { locale: "de" });
      expect(readerList.status).toBe(200);
      expect((await readerList.json()).map((template: { id: string; name: string }) => [template.id, template.name])).toEqual([
        ["meeting-notes", "Besprechungsprotokoll"],
        ["project-page", "Projektseite"],
        ["decision-record", "Entscheidung"],
      ]);

      // Saving, using and filling in need write access.
      const save = { method: "POST", body: { name: "Weekly", noteId: page.data.shortId } };
      expect((await asReader(`/${notebook.shortId}/page-templates`, save)).status).toBe(403);
      expect((await asReader(`/${notebook.shortId}/notes`, { method: "POST", body: { templateId: "meeting-notes" } })).status).toBe(403);
      expect((await asReader(`/${notebook.shortId}/page-templates/meeting-notes/draft`)).status).toBe(403);

      const saved = await asWriter(`/${notebook.shortId}/page-templates`, save);
      expect(saved.status).toBe(201);
      const own = (await saved.json()) as { id: string; name: string; builtIn: boolean };
      expect(own).toMatchObject({ name: "Weekly", builtIn: false, icon: "ti ti-template", description: null });
      // Names are unique per notebook, ignoring case; the first save is untouched.
      expect((await asWriter(`/${notebook.shortId}/page-templates`, { ...save, body: { ...save.body, name: " weekly " } })).status).toBe(
        409,
      );
      // Only a page of the same notebook becomes its template.
      expect(
        (
          await asWriter(`/${notebook.shortId}/page-templates`, {
            method: "POST",
            body: { name: "Foreign", noteId: foreignPage.data.shortId },
          })
        ).status,
      ).toBe(404);

      // Own templates come first; a reader sees them as well.
      const listed = (await (await asReader(`/${notebook.shortId}/page-templates`)).json()) as { id: string; builtIn: boolean }[];
      expect(listed.map((template) => template.id)).toEqual([own.id, "meeting-notes", "project-page", "decision-record"]);

      // A new page from the template gets today's date and the caller's name; other placeholders stay as typed.
      const created = await asWriter(`/${notebook.shortId}/notes`, { method: "POST", body: { templateId: own.id } });
      expect(created.status).toBe(200);
      const note = (await created.json()) as { id: string; title: string };
      const content = (await notebooksService.note.getWithContentByShortId({ shortId: note.id }))?.contentMd ?? "";
      expect(content).toMatch(/^# Weekly \d{4}-\d{2}-\d{2}\n/);
      expect(content).toContain("- **By:** Wanda Writer\n");
      expect(content).toContain("- {{ unknown }}\n");
      expect(note.title).toMatch(/^Weekly \d{4}-\d{2}-\d{2}$/);
      expect(
        (await asWriter(`/${notebook.shortId}/notes`, { method: "POST", body: { templateId: own.id, contentMd: "# Both" } })).status,
      ).toBe(400);

      // Built-in templates fill in the same way, in the caller's language.
      const draft = await asWriter(`/${notebook.shortId}/page-templates/meeting-notes/draft`, { locale: "de" });
      expect(draft.status).toBe(200);
      const drafted = (await draft.json()) as { name: string; contentMd: string };
      expect(drafted.name).toBe("Besprechungsprotokoll");
      expect(drafted.contentMd).toContain("- **Protokoll:** Wanda Writer\n");
      expect(drafted.contentMd).not.toContain("{{");

      // A template of one notebook does not exist in another, even for the same writer.
      expect((await asWriter(`/${other.shortId}/page-templates/${own.id}/draft`)).status).toBe(404);
      expect((await asWriter(`/${other.shortId}/notes`, { method: "POST", body: { templateId: own.id } })).status).toBe(404);
      expect((await asWriter(`/${other.shortId}/page-templates/${own.id}`, { method: "DELETE" })).status).toBe(404);

      // Writers rename and replace own templates; built-in ones stay as they are.
      const renamed = await asWriter(`/${notebook.shortId}/page-templates/${own.id}`, { method: "PATCH", body: { name: "Weekly sync" } });
      expect(renamed.status).toBe(200);
      expect(await renamed.json()).toMatchObject({ id: own.id, name: "Weekly sync" });
      expect((await asReader(`/${notebook.shortId}/page-templates/${own.id}`, { method: "PATCH", body: { name: "Mine" } })).status).toBe(
        403,
      );
      expect(
        (await asWriter(`/${notebook.shortId}/page-templates/meeting-notes`, { method: "PATCH", body: { name: "Mine" } })).status,
      ).toBe(400);
      expect((await asWriter(`/${notebook.shortId}/page-templates/meeting-notes`, { method: "DELETE" })).status).toBe(400);

      // The bound counts own templates per notebook.
      await sql`
        INSERT INTO notebooks.page_templates (short_id, notebook_id, name, content_md)
        SELECT 'o' || lpad(to_hex(n), 5, '0'), ${notebook.id}::uuid, 'Bulk ' || n, '# Bulk'
        FROM generate_series(1, ${PAGE_TEMPLATE_LIMIT - 1}) AS n
        ON CONFLICT DO NOTHING
      `;
      const full = await asWriter(`/${notebook.shortId}/page-templates`, { ...save, body: { ...save.body, name: "One more" } });
      expect(full.status).toBe(409);
      expect((await (await asWriter(`/${notebook.shortId}/page-templates`)).json()).length).toBe(PAGE_TEMPLATE_LIMIT + 3);

      // Deleting leaves pages made from the template as they are.
      expect((await asReader(`/${notebook.shortId}/page-templates/${own.id}`, { method: "DELETE" })).status).toBe(403);
      expect((await asWriter(`/${notebook.shortId}/page-templates/${own.id}`, { method: "DELETE" })).status).toBe(200);
      expect((await asWriter(`/${notebook.shortId}/page-templates/${own.id}`, { method: "DELETE" })).status).toBe(404);
      expect(await notebooksService.note.getByShortId({ shortId: note.id })).not.toBeNull();

      // The service enforces the rule for every caller, not only these routes.
      const direct = { notebookId: notebook.id, templateId: "meeting-notes", placeholders: { date: "2026-01-02", author: "A" } };
      expect(await notebooksService.pageTemplate.draft({ ...direct, permission: "read" })).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN" },
      });
      expect(await notebooksService.pageTemplate.list({ notebookId: notebook.id, permission: "none" })).toMatchObject({ ok: false });
      expect(
        await notebooksService.pageTemplate.create({
          notebookId: notebook.id,
          permission: "read",
          name: "Direct",
          noteId: page.data.id,
          createdBy: reader,
        }),
      ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    } finally {
      for (const id of [notebook.id, other.id]) await sql`DELETE FROM notebooks.notebooks WHERE id = ${id}::uuid`;
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
});
