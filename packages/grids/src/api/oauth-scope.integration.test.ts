import { expect, test } from "bun:test";
import { sql } from "bun";
import { assertAdminMutationsRejectReadOAuth, withAdminOAuth } from "../../../../scripts/fixtures/admin-oauth";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { testShortId, testUuid } from "../integration-test-utils";
import "../../../../scripts/fixtures/authorization-preload";
import { grantAccess } from "../service/access";
import routes from "./index";

suiteFor(
  "database",
  "nats",
  "valkey",
)("grids resource OAuth ceiling", () => {
  test("every protected mutation rejects a real read-only user OAuth token", () =>
    withAdminOAuth(async ({ readHeaders }) => {
      await assertAdminMutationsRejectReadOAuth(
        routes,
        readHeaders,
        (path) => !path.startsWith("/admin/") && !path.startsWith("/forms/public/"),
      );
    }));
});

suiteFor(
  "database",
  "nats",
  "valkey",
)("Grids document preview OAuth ceiling", () => {
  test("read-only OAuth cannot create scan authority; browser previews keep their scan metadata", () =>
    withAdminOAuth(
      async ({ userId, readHeaders, sessionHeaders }) => {
        const baseId = testUuid(),
          tableId = testUuid(),
          fieldId = testUuid(),
          recordId = testUuid();
        const base = testShortId(),
          table = testShortId(),
          field = testShortId(),
          record = testShortId();
        let accessId: string | undefined;
        try {
          await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${base}, 'OAuth preview')`;
          const granted = await grantAccess({
            resourceType: "base",
            resourceId: baseId,
            principal: { type: "user", userId },
            permission: "admin",
          });
          if (!granted.ok) throw new Error(granted.error.message);
          accessId = granted.data.accessId;
          await sql`INSERT INTO grids.tables (id, short_id, base_id, name) VALUES (${tableId}::uuid, ${table}, ${baseId}::uuid, 'Drafts')`;
          await sql`INSERT INTO grids.fields (id, short_id, table_id, name, type, config) VALUES (${fieldId}::uuid, ${field}, ${tableId}::uuid, 'Subject', 'text', '{}'::jsonb)`;
          await sql`INSERT INTO grids.records (id, short_id, table_id, data) VALUES (${recordId}::uuid, ${record}, ${tableId}::uuid, ${{ [fieldId]: "Draft" }}::jsonb)`;
          for (const source of [`from table {${table}}\nselect {${field}}\nlimit 1`, "invalid gql source"]) {
            const response = await routes.request(`/documents/templates/by-table/${table}/preview-data-draft`, {
              method: "POST",
              headers: { ...readHeaders, "content-type": "application/json" },
              body: JSON.stringify({
                recordId: record,
                source,
                renderer: {
                  kind: "html",
                  body: "<p>{{ rows.first.Subject }}</p>",
                  numberTemplate: "PREVIEW",
                  filenameTemplate: "preview.pdf",
                },
              }),
            });
            expect(response.status).toBe(403);
            const [row] = await sql`SELECT count(*)::int AS count FROM grids.record_scan_codes WHERE base_id = ${baseId}::uuid`;
            expect(row!.count).toBe(0);
          }
          const browser = await routes.request(`/documents/templates/by-table/${table}/preview-data-draft`, {
            method: "POST",
            headers: { ...sessionHeaders, "content-type": "application/json" },
            body: JSON.stringify({
              recordId: record,
              source: `from table {${table}}\nselect {${field}}\nlimit 1`,
              renderer: {
                kind: "html",
                body: "<p>{{ rows.first.Subject }}</p>",
                numberTemplate: "PREVIEW",
                filenameTemplate: "preview.pdf",
              },
            }),
          });
          expect(browser.status).toBe(200);
          const [created] = await sql`SELECT count(*)::int AS count FROM grids.record_scan_codes WHERE base_id = ${baseId}::uuid`;
          expect(created!.count).toBe(1);
        } finally {
          await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
          if (accessId) await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
        }
      },
      { admin: false },
    ));
});
