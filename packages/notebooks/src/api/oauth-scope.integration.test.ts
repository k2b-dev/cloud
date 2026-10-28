import { expect, test } from "bun:test";
import { sql } from "bun";
import { assertAdminMutationsRejectReadOAuth, withAdminOAuth, withPersonalApiKey } from "../../../../scripts/fixtures/admin-oauth";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { notebooksService } from "../service";
import "../../../../scripts/fixtures/authorization-preload";
import "../frontend/[id]/_components/detail/ssr-test-plugin";

const { default: routes } = await import("./index");

suiteFor(
  "database",
  "nats",
  "valkey",
)("notebooks resource OAuth ceiling", () => {
  test("every protected mutation rejects a real read-only user OAuth token", () =>
    withAdminOAuth(async ({ readHeaders }) => {
      await assertAdminMutationsRejectReadOAuth(routes, readHeaders, (path) => !path.startsWith("/admin/"));
    }));
});

suiteFor(
  "database",
  "nats",
  "valkey",
)("Notebooks ordinary user credential ceiling", () => {
  test("read OAuth cannot rename a notebook; write OAuth, browser and personal keys still can", () =>
    withAdminOAuth(
      async ({ userId, readHeaders, writeHeaders, adminHeaders, sessionHeaders }) => {
        const notebook = await notebooksService.notebook.create({
          data: { name: "OAuth scope fixture" },
          creatorId: userId,
          seedWelcome: false,
        });
        if (!notebook.ok) throw new Error(String(notebook.error));
        const id = notebook.data.id;
        const path = `/${notebook.data.shortId}`;
        const patch = (headers: Record<string, string>, name: string) =>
          routes.request(path, {
            method: "PATCH",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ name }),
          });
        try {
          expect((await routes.request(path, { headers: readHeaders })).status).toBe(200);
          await withPersonalApiKey(userId, async (keyHeaders) => {
            for (const [index, headers] of [writeHeaders, adminHeaders, sessionHeaders, keyHeaders].entries()) {
              const [before] = await sql<{ name: string }[]>`SELECT name FROM notebooks.notebooks WHERE id=${id}::uuid`;
              expect((await patch(readHeaders, "Rejected")).status).toBe(403);
              const [after] = await sql<{ name: string }[]>`SELECT name FROM notebooks.notebooks WHERE id=${id}::uuid`;
              expect(after!.name).toBe(before!.name);
              expect((await patch(headers, `Allowed ${index}`)).status).toBe(200);
            }
          });
          const note = await notebooksService.note.create({
            data: { notebookId: id, contentMd: "# Read-only preview\n" },
            creatorId: userId,
          });
          if (!note.ok) throw new Error(String(note.error));
          const preview = await routes.request(`${path}/notes/${note.data.shortId}/block-preview`, {
            method: "POST",
            headers: { ...readHeaders, "content-type": "application/json" },
            body: "{}",
          });
          expect(preview.status).toBe(200);
        } finally {
          await sql`DELETE FROM notebooks.notebooks WHERE id=${id}::uuid`;
        }
      },
      { admin: false },
    ));
});
