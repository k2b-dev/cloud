import { beforeAll, describe, expect } from "bun:test";
import { sql } from "@k2b/cloud";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { listForBase } from "./base-catalog";
import { listSummariesByBase } from "./custom-apps";
import { createWorkflow, listWorkflows } from "./workflow-definitions";
import { deleteTestWorkflow, deleteTestWorkflowScope } from "./workflow-test-fixture";

beforeAll(async () => {
  if (testInfra.database) await migrate();
});

const grant = async (userId: string, permission: "none" | "read" | "write" | "admin"): Promise<string> => {
  const id = testUuid();
  await sql`
    INSERT INTO auth.access (id, user_id, permission)
    VALUES (${id}::uuid, ${userId}::uuid, ${permission}::auth.permission_level)
  `;
  return id;
};

describe("base catalog integration", () => {
  postgresTest("preserves JSON-looking text and falsy defaults in the authorized catalog", async () => {
    const userId = testUuid();
    const baseId = testUuid();
    const tableId = testUuid();
    const defaults = [
      { name: "JSON text", type: "text", value: '{"kind":"now"}' },
      { name: "Array text", type: "text", value: '["item"]' },
      { name: "Incomplete text", type: "text", value: "{unfinished" },
      { name: "Disabled", type: "boolean", value: false },
      { name: "Duration", type: "duration", value: 0 },
    ];
    try {
      await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn)
        VALUES (${userId}::uuid, ${`catalog-${userId}`}, 'local', 'user', 'Catalog User', 'Catalog', 'User')`;
      await sql`INSERT INTO grids.bases (id, short_id, name)
        VALUES (${baseId}::uuid, ${testShortId()}, 'Default catalog')`;
      await sql`INSERT INTO grids.tables (id, short_id, base_id, name)
        VALUES (${tableId}::uuid, ${testShortId()}, ${baseId}::uuid, 'Defaults')`;
      for (const [position, entry] of defaults.entries()) {
        await sql`INSERT INTO grids.fields (id, short_id, table_id, name, type, config, default_value, position)
          VALUES (${testUuid()}::uuid, ${testShortId()}, ${tableId}::uuid, ${entry.name}, ${entry.type},
            '{}'::jsonb, ${JSON.stringify(entry.value)}::text::jsonb, ${position})`;
      }
      const baseAccess = await grant(userId, "read");
      await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${baseAccess}::uuid)`;
      const catalog = await listForBase({ baseId, userId, userGroups: [] });
      expect(catalog.fieldsByTable[tableId]?.map(({ name, defaultValue }) => ({ name, value: defaultValue }))).toEqual(
        defaults.map(({ name, value }) => ({ name, value })),
      );
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  postgresTest("projects every live resource at the owning base level", async () => {
    const userId = testUuid();
    const baseId = testUuid();
    const readableTableId = testUuid();
    const deniedTableId = testUuid();
    const formOnlyTableId = testUuid();
    const documentOnlyTableId = testUuid();
    const deletedTableId = testUuid();
    const formId = testUuid();
    const templateId = testUuid();
    const deletedTemplateId = testUuid();
    try {
      await sql`
        INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn)
        VALUES (${userId}::uuid, ${`catalog-${userId}`}, 'local', 'user', 'Catalog User', 'Catalog', 'User')
      `;
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId()}, 'Catalog')`;
      await sql`
        INSERT INTO grids.tables (id, short_id, base_id, name, position, deleted_at) VALUES
          (${readableTableId}::uuid, ${testShortId()}, ${baseId}::uuid, 'Readable', 0, NULL),
          (${deniedTableId}::uuid, ${testShortId()}, ${baseId}::uuid, 'Denied', 1, NULL),
          (${formOnlyTableId}::uuid, ${testShortId()}, ${baseId}::uuid, 'Form only', 2, NULL),
          (${documentOnlyTableId}::uuid, ${testShortId()}, ${baseId}::uuid, 'Document only', 3, NULL),
          (${deletedTableId}::uuid, ${testShortId()}, ${baseId}::uuid, 'Deleted', 4, now())
      `;
      for (const [position, tableId] of [readableTableId, deniedTableId, formOnlyTableId, documentOnlyTableId, deletedTableId].entries()) {
        await sql`
          INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
          VALUES (${testUuid()}::uuid, ${testShortId()}, ${tableId}::uuid, ${`Field ${position}`}, 'text', '{}'::jsonb, ${position})
        `;
      }
      await sql`
        INSERT INTO grids.forms (id, short_id, table_id, name, config, is_active)
        VALUES (${formId}::uuid, ${testShortId()}, ${formOnlyTableId}::uuid, 'Submit', '{}'::jsonb, TRUE)
      `;
      await sql`
        INSERT INTO grids.document_templates (id, short_id, table_id, name, source, html, renderer_kind, number_template, filename_template, deleted_at) VALUES
          (${templateId}::uuid, ${testShortId()}, ${documentOnlyTableId}::uuid, 'Invoice', 'from table "Document only"', '<p>Invoice</p>', 'html', '{{ series.value }}', '{{ document.number }}.pdf', NULL),
          (${deletedTemplateId}::uuid, ${testShortId()}, ${documentOnlyTableId}::uuid, 'Old invoice', 'from table "Document only"', '<p>Old</p>', 'html', '{{ series.value }}', '{{ document.number }}.pdf', now())
      `;

      const baseAccess = await grant(userId, "write");
      await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${baseAccess}::uuid)`;

      const catalog = await listForBase({ baseId, userId, userGroups: [] });
      expect(catalog.tables.map((table) => table.id)).toEqual([readableTableId, deniedTableId, formOnlyTableId, documentOnlyTableId]);
      expect(catalog.tableLevels).toEqual({
        [readableTableId]: "write",
        [deniedTableId]: "write",
        [formOnlyTableId]: "write",
        [documentOnlyTableId]: "write",
      });
      expect(Object.keys(catalog.fieldsByTable)).toEqual(
        expect.arrayContaining([readableTableId, deniedTableId, formOnlyTableId, documentOnlyTableId]),
      );
      expect(catalog.fieldsByTable[deletedTableId]).toBeUndefined();
      expect(catalog.formTables).toEqual([]);
      expect(catalog.sidebarForms.map(({ form }) => form.id)).toEqual([formId]);
      expect(catalog.documentTemplateTables).toEqual([]);
      expect(catalog.sidebarDocumentTemplates.map(({ template }) => template.id)).toEqual([templateId]);
      expect(catalog.documentTemplateLevels).toEqual({ [templateId]: "write" });
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  // The catalog reads all seven kinds in one statement (as JSON): each kind keeps its own order, only live resources
  // of live tables of this base, the same values as a plain read (dates, JSON columns), and the same visibility per
  // person: a reader gets no sidebar forms and form secrets, apps only for who manages the base, nothing without access.
  postgresTest("reads tables, fields, views, forms, documents, workflows and apps of this base, per person", async () => {
    const [admin, reader, stranger] = [testUuid(), testUuid(), testUuid()];
    const [baseId, otherBaseId] = [testUuid(), testUuid()];
    const [orders, parts, gone, otherTable] = [testUuid(), testUuid(), testUuid(), testUuid()];
    const ids = { view: testUuid(), goneView: testUuid(), form: testUuid(), idleForm: testUuid(), template: testUuid() };
    const [app, goneApp] = [testUuid(), testUuid()];
    const accessIds: string[] = [];
    try {
      for (const [id, name] of [
        [admin, "Mira Solberg"],
        [reader, "Jonas Kern"],
        [stranger, "Ada Brandt"],
      ] as const)
        await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn)
          VALUES (${id}::uuid, ${`catalog-${id}`}, 'local', 'user', ${name}, ${name.split(" ")[0]!}, ${name.split(" ")[1]!})`;
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES
        (${baseId}::uuid, ${testShortId()}, 'Werkstatt'), (${otherBaseId}::uuid, ${testShortId()}, 'Elsewhere')`;
      await sql`INSERT INTO grids.tables (id, short_id, base_id, name, position, deleted_at) VALUES
        (${parts}::uuid, ${testShortId()}, ${baseId}::uuid, 'Ersatzteile', 1, NULL),
        (${orders}::uuid, ${testShortId()}, ${baseId}::uuid, 'Aufträge', 0, NULL),
        (${gone}::uuid, ${testShortId()}, ${baseId}::uuid, 'Alt', 2, now()),
        (${otherTable}::uuid, ${testShortId()}, ${otherBaseId}::uuid, 'Fremd', 0, NULL)`;
      for (const [position, tableId] of [orders, orders, parts, gone, otherTable].entries())
        await sql`INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
          VALUES (${testUuid()}::uuid, ${testShortId()}, ${tableId}::uuid, ${`Feld ${position}`}, 'text', '{"hint":"x"}'::jsonb, ${position})`;
      await sql`INSERT INTO grids.views (id, short_id, table_id, name, source, ui, position, deleted_at) VALUES
        (${ids.view}::uuid, ${testShortId()}, ${orders}::uuid, 'Offen', 'from table "Aufträge"', '{"groupedColumnOrder":["Status"]}'::jsonb, 0, NULL),
        (${ids.goneView}::uuid, ${testShortId()}, ${orders}::uuid, 'Alt', 'from table "Aufträge"', '{}'::jsonb, 1, now()),
        (${testUuid()}::uuid, ${testShortId()}, ${otherTable}::uuid, 'Fremd', 'from table "Fremd"', '{}'::jsonb, 0, NULL)`;
      await sql`INSERT INTO grids.forms (id, short_id, table_id, name, config, is_active, public_token, position) VALUES
        (${ids.form}::uuid, ${testShortId()}, ${orders}::uuid, 'Auftrag melden', '{}'::jsonb, TRUE, 'secret-token', 0),
        (${ids.idleForm}::uuid, ${testShortId()}, ${parts}::uuid, 'Teil anfragen', '{}'::jsonb, FALSE, NULL, 0)`;
      await sql`INSERT INTO grids.document_templates (id, short_id, table_id, name, source, html, renderer_kind, number_template, filename_template, enabled) VALUES
        (${ids.template}::uuid, ${testShortId()}, ${orders}::uuid, 'Auftragsblatt', 'from table "Aufträge"', '<p>Auftrag</p>', 'html', '{{ series.value }}', '{{ document.number }}.pdf', TRUE)`;
      const workflow = await createWorkflow(
        baseId,
        { name: "Erinnern", source: "steps:\n  - succeed:\n      message: done", enabled: true },
        null,
      );
      const goneWorkflow = await createWorkflow(
        baseId,
        { name: "Alt", source: "steps:\n  - succeed:\n      message: old", enabled: true },
        null,
      );
      const otherWorkflow = await createWorkflow(
        otherBaseId,
        { name: "Fremd", source: "steps:\n  - succeed:\n      message: x", enabled: true },
        null,
      );
      if (!workflow.ok || !goneWorkflow.ok || !otherWorkflow.ok) throw new Error("the workflows were not created");
      await deleteTestWorkflow(goneWorkflow.data.id);
      await sql`INSERT INTO grids.custom_apps (id, short_id, base_id, name, draft_definition, published_definition, published_at, deleted_at) VALUES
        (${app}::uuid, ${testShortId()}, ${baseId}::uuid, 'Annahme', '{}'::jsonb, '{}'::jsonb, now(), NULL),
        (${goneApp}::uuid, ${testShortId()}, ${baseId}::uuid, 'Alt', '{}'::jsonb, NULL, NULL, now()),
        (${testUuid()}::uuid, ${testShortId()}, ${otherBaseId}::uuid, 'Fremd', '{}'::jsonb, NULL, NULL, NULL)`;
      for (const [userId, permission] of [
        [admin, "admin"],
        [reader, "read"],
        [stranger, "none"],
      ] as const) {
        const accessId = await grant(userId, permission);
        accessIds.push(accessId);
        await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${accessId}::uuid)`;
      }

      const managed = await listForBase({ baseId, userId: admin, userGroups: [], customApps: true });
      // each kind in its own order, live and of this base only
      expect(managed.tables.map((table) => table.id)).toEqual([orders, parts]);
      expect(Object.keys(managed.fieldsByTable).sort()).toEqual([orders, parts].sort());
      expect(managed.fieldsByTable[orders]?.map((field) => field.name)).toEqual(["Feld 0", "Feld 1"]);
      expect(managed.fieldsByTable[orders]?.[0]?.config).toEqual({ hint: "x" });
      expect(managed.viewsByTable).toEqual({
        [orders]: [expect.objectContaining({ id: ids.view, ui: expect.objectContaining({ groupedColumnOrder: ["Status"] }) })],
      });
      expect(managed.formsByTable[orders]?.[0]).toMatchObject({ id: ids.form, publicToken: "secret-token" });
      expect(managed.sidebarForms.map(({ form }) => form.id)).toEqual([ids.form]);
      expect(managed.sidebarDocumentTemplates.map(({ template }) => template.id)).toEqual([ids.template]);
      // the same values as a plain read of each kind, dates and JSON columns included
      expect(managed.workflows).toEqual(await listWorkflows(baseId));
      expect(managed.workflows.map((each) => each.id)).toEqual([workflow.data.id]);
      expect(managed.customApps).toEqual(await listSummariesByBase(baseId));
      expect(managed.customApps.map((each) => each.id)).toEqual([app]);
      const [stored] = await sql<{ created_at: Date; updated_at: Date }[]>`
        SELECT created_at, updated_at FROM grids.tables WHERE id = ${orders}::uuid`;
      expect(managed.tables[0]).toMatchObject({ createdAt: stored!.created_at.toISOString(), updatedAt: stored!.updated_at.toISOString() });

      // a reader: the same resources, no sidebar forms, no form secrets, no apps
      const read = await listForBase({ baseId, userId: reader, userGroups: [], customApps: false });
      expect(read.tables.map((table) => table.id)).toEqual([orders, parts]);
      expect(read.tableLevels).toEqual({ [orders]: "read", [parts]: "read" });
      expect(read.formsByTable[orders]?.[0]).toMatchObject({ id: ids.form, publicToken: null });
      expect(read.sidebarForms).toEqual([]);
      expect(read.workflows.map((each) => each.id)).toEqual([workflow.data.id]);
      expect(read.customApps).toEqual([]);

      // without access: nothing at all
      const none = await listForBase({ baseId, userId: stranger, userGroups: [], customApps: true });
      expect([none.tables, none.workflows, none.customApps, none.sidebarForms, none.sidebarDocumentTemplates]).toEqual([
        [],
        [],
        [],
        [],
        [],
      ]);
    } finally {
      await deleteTestWorkflowScope(baseId);
      await deleteTestWorkflowScope(otherBaseId);
      await sql`DELETE FROM grids.bases WHERE id IN (${baseId}::uuid, ${otherBaseId}::uuid)`;
      for (const id of accessIds) await sql`DELETE FROM auth.access WHERE id = ${id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id IN (${admin}::uuid, ${reader}::uuid, ${stranger}::uuid)`;
    }
  });
});
