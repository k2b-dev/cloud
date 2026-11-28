import { afterAll, beforeAll, describe, expect } from "bun:test";
import { sql } from "@k2b/cloud";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { listForBase } from "./base-catalog";
import { createWorkflow } from "./workflow-definitions";
import { deleteTestWorkflowScope } from "./workflow-test-fixture";

// What a base's navigation lists costs two statements, whatever the base holds: the person's grant and one catalog
// statement for all seven kinds. Every page of a base reads it. Measured with sql-meter, alone in this file (#4494).
const fixture = { admin: testUuid(), baseId: testUuid(), accessId: "" };

beforeAll(async () => {
  if (!testInfra.database) return;
  await migrate();
  await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn)
    VALUES (${fixture.admin}::uuid, ${`catalog-meter-${fixture.admin}`}, 'local', 'user', 'Mira Solberg', 'Mira', 'Solberg')`;
  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${fixture.baseId}::uuid, ${testShortId()}, 'Werkstatt')`;
  for (const position of [0, 1, 2]) {
    const tableId = testUuid();
    await sql`INSERT INTO grids.tables (id, short_id, base_id, name, position)
      VALUES (${tableId}::uuid, ${testShortId()}, ${fixture.baseId}::uuid, ${`Tabelle ${position}`}, ${position})`;
    await sql`INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
      VALUES (${testUuid()}::uuid, ${testShortId()}, ${tableId}::uuid, 'Name', 'text', '{}'::jsonb, 0)`;
    await sql`INSERT INTO grids.views (id, short_id, table_id, name, source, position)
      VALUES (${testUuid()}::uuid, ${testShortId()}, ${tableId}::uuid, ${`Ansicht ${position}`}, ${`from table "Tabelle ${position}"`}, 0)`;
    await sql`INSERT INTO grids.forms (id, short_id, table_id, name, config, is_active)
      VALUES (${testUuid()}::uuid, ${testShortId()}, ${tableId}::uuid, ${`Formular ${position}`}, '{}'::jsonb, TRUE)`;
    await sql`INSERT INTO grids.document_templates (id, short_id, table_id, name, source, html, renderer_kind, number_template, filename_template)
      VALUES (${testUuid()}::uuid, ${testShortId()}, ${tableId}::uuid, ${`Blatt ${position}`}, ${`from table "Tabelle ${position}"`}, '<p>x</p>', 'html', '{{ series.value }}', '{{ document.number }}.pdf')`;
  }
  const workflow = await createWorkflow(
    fixture.baseId,
    { name: "Erinnern", source: "steps:\n  - succeed:\n      message: done", enabled: true },
    null,
  );
  if (!workflow.ok) throw workflow.error;
  await sql`INSERT INTO grids.custom_apps (id, short_id, base_id, name, draft_definition)
    VALUES (${testUuid()}::uuid, ${testShortId()}, ${fixture.baseId}::uuid, 'Annahme', '{}'::jsonb)`;
  const [grant] = await sql<{ id: string }[]>`
    INSERT INTO auth.access (user_id, permission) VALUES (${fixture.admin}::uuid, 'admin'::auth.permission_level) RETURNING id::text AS id`;
  fixture.accessId = grant!.id;
  await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${fixture.baseId}::uuid, ${fixture.accessId}::uuid)`;
});

afterAll(async () => {
  if (!testInfra.database) return;
  await deleteTestWorkflowScope(fixture.baseId);
  await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
  await sql`DELETE FROM auth.access WHERE id = ${fixture.accessId}::uuid`;
  await sql`DELETE FROM auth.users WHERE id = ${fixture.admin}::uuid`;
});

describe("the catalog of a base", () => {
  postgresTest("lists all seven kinds for who manages the base in two statements", async () => {
    const meter = await meterSql();
    try {
      let catalog: Awaited<ReturnType<typeof listForBase>> | undefined;
      const statements = await meter.during(async () => {
        catalog = await listForBase({ baseId: fixture.baseId, userId: fixture.admin, userGroups: [], customApps: true });
      });
      expect(catalog?.tables).toHaveLength(3);
      expect(catalog?.workflows).toHaveLength(1);
      expect(catalog?.customApps).toHaveLength(1);
      expect(statements).toHaveLength(2);
    } finally {
      await meter.close();
    }
  });
});
