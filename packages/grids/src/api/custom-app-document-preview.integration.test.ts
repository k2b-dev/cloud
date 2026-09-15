import { beforeAll, expect, spyOn } from "bun:test";
import { sql } from "bun";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { gridsService } from "../service";
import { grantAccess } from "../service/access";
import { apply, publish } from "../service/custom-apps";
import * as durableHistory from "../service/durable-history";
import * as finalization from "../service/record-finalization";
import { createCustomAppsApi } from "./custom-apps";

beforeAll(async () => { if (process.env.GRIDS_DB_TEST === "1") await migrate(); });

postgresTest("published draft preview is an explicit pinned data-product grant without issuance", async () => {
  const baseId = testUuid(), tableId = testUuid(), fieldId = testUuid(), recordId = testUuid(), templateId = testUuid();
  const base = testShortId("B"), table = testShortId("T"), field = testShortId("F"), record = testShortId("R"), template = testShortId("D");
  let accessId: string | undefined;
  const render = spyOn(gridsService.document, "renderPdfPreview").mockImplementation(async (_template, data) => {
    expect(data.record).toMatchObject({ id: record });
    expect(data.rows).toEqual([expect.objectContaining({ Subject: "Saved draft" })]);
    return { ok: true, html: "<p>Preview</p>", headerHtml: null, footerHtml: null, pageCss: null, pdf: { pdf: new TextEncoder().encode("%PDF-preview"), contentType: "application/pdf" } };
  });
  try {
    await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${base}, 'Preview test')`;
    await sql`INSERT INTO grids.tables (id, short_id, base_id, name) VALUES (${tableId}::uuid, ${table}, ${baseId}::uuid, 'Drafts')`;
    await sql`INSERT INTO grids.fields (id, short_id, table_id, name, type, config) VALUES (${fieldId}::uuid, ${field}, ${tableId}::uuid, 'Subject', 'text', '{}'::jsonb)`;
    await sql`INSERT INTO grids.records (id, short_id, table_id, data) VALUES (${recordId}::uuid, ${record}, ${tableId}::uuid, ${{ [fieldId]: "Saved draft" }}::jsonb)`;
    const source = `from table {${table}}\nselect {${field}}\nwhere record.id = '{{ record.id }}'\nlimit 1`;
    await sql`INSERT INTO grids.document_templates (id, short_id, table_id, name, source, renderer_kind, html, number_template, filename_template)
      VALUES (${templateId}::uuid, ${template}, ${tableId}::uuid, 'Preview', ${source}, 'html', '<p>{{ rows.first.Subject }}</p>', 'PREVIEW', 'preview.pdf')`;
    const documents = { templateIds: [template], preview: true };
    const definition = { schemaVersion: 5, kind: "grids.custom-app", id: testShortId("A"), baseId: base, name: "Draft portal", startPageId: "home",
      pages: [{ id: "home", title: "Home", navigation: { visible: true }, parameters: {}, rows: [{ id: "main", columns: [{ id: "content", span: 12, blocks: [{ id: "welcome", type: "markdown", markdown: "Draft portal" }] }] }] },
        { id: "detail", title: "Draft", navigation: { visible: false }, parameters: { item: { type: "record", tableId: table, required: true } },
        record: { tableId: table, id: { source: "PARAMS", path: "item" } },
        rows: [{ id: "main", columns: [{ id: "content", span: 12, blocks: [{ id: "record", type: "record", fieldIds: [field],
          documents }] }] }] }] };
    const applied = await apply(definition);
    if (!applied.ok) throw new Error(applied.error.message);
    const published = await publish(applied.data.id);
    if (!published.ok) throw new Error(published.error.message);
    const grant = await grantAccess({ resourceType: "customApp", resourceId: applied.data.id, permission: "read", principal: { type: "public" } });
    if (!grant.ok) throw new Error(grant.error.message);
    accessId = grant.data.accessId;
    const api = createCustomAppsApi({ requireAuthenticated: async (c) => c.json({ message: "Sign in" }, 401) });
    const path = `/runtime/${applied.data.shortId}/detail/record/document-previews/${template}?item=${record}`;
    const response = await api.request(path, { method: "POST" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.text()).toBe("%PDF-preview");
    const [unchanged] = await sql`SELECT finalized_at, version FROM grids.records WHERE id = ${recordId}::uuid`;
    expect(unchanged.finalized_at).toBeNull();
    expect(Number(unchanged.version)).toBe(1);
    const [issued] = await sql`SELECT count(*)::int AS count FROM grids.documents WHERE base_id = ${baseId}::uuid`;
    expect(issued.count).toBe(0);
    const [scanCodes] = await sql`SELECT count(*)::int AS count FROM grids.record_scan_codes WHERE base_id = ${baseId}::uuid`;
    expect(scanCodes.count).toBe(0);
    expect(render).toHaveBeenCalledTimes(1);
    expect((await api.request(path.replace(`item=${record}`, `item=${testShortId("Z")}`), { method: "POST" })).status).toBe(404);
    await sql`UPDATE grids.fields SET name = 'Changed subject' WHERE id = ${fieldId}::uuid`;
    expect((await api.request(path, { method: "POST" })).status).toBe(409);
    expect(render).toHaveBeenCalledTimes(1);
    await sql`UPDATE grids.fields SET name = 'Subject' WHERE id = ${fieldId}::uuid`;
    documents.preview = false;
    expect((await apply(definition)).ok).toBe(true);
    expect((await publish(applied.data.id)).ok).toBe(true);
    expect((await api.request(path, { method: "POST" })).status).toBe(404);
    expect(render).toHaveBeenCalledTimes(1);
    documents.preview = true;
    expect((await apply(definition)).ok).toBe(true);
    expect((await publish(applied.data.id)).ok).toBe(true);
    await sql`UPDATE grids.document_templates SET html = '<p>Changed</p>' WHERE id = ${templateId}::uuid`;
    expect((await api.request(path, { method: "POST" })).status).toBe(409);
    expect(render).toHaveBeenCalledTimes(1);
    await sql`UPDATE grids.document_templates SET source = ${`from table {${table}}\nselect {${field}}\nwhere {${field}} = '{{ record.data.${field} }}'`} WHERE id = ${templateId}::uuid`;
    expect((await publish(applied.data.id)).ok).toBe(false);
    await sql`UPDATE grids.document_templates SET source = ${source} WHERE id = ${templateId}::uuid`;
    expect((await durableHistory.enable(tableId, null)).ok).toBe(true);
    expect((await finalization.enable(tableId, { mode: "direct" }, null)).ok).toBe(true);
    expect((await publish(applied.data.id)).ok).toBe(true);
    const finalized = await finalization.finalize({ tableId, recordId, actorId: null, origin: "direct" });
    if (!finalized.ok) throw finalized.error;
    expect((await api.request(path, { method: "POST" })).status).toBe(409);
    expect(render).toHaveBeenCalledTimes(1);
    await sql`DELETE FROM grids.custom_app_access WHERE custom_app_id = ${applied.data.id}::uuid`;
    expect((await api.request(path, { method: "POST" })).status).toBe(404);
  } finally {
    render.mockRestore();
    // Only this disposable fixture; follow the finalization integration cleanup.
    await sql`UPDATE grids.records SET finalized_at = NULL, finalized_by = NULL, final_revision_id = NULL WHERE table_id = ${tableId}::uuid`;
    await sql`DELETE FROM grids.file_protected_references WHERE base_id = ${baseId}::uuid`;
    await sql`DELETE FROM grids.record_revisions WHERE table_id = ${tableId}::uuid`;
    await sql`DELETE FROM grids.record_finalization_requests WHERE table_id = ${tableId}::uuid`;
    await sql`DELETE FROM grids.table_finalization_activations WHERE table_id = ${tableId}::uuid`;
    await sql`DELETE FROM grids.durable_history_activations WHERE table_id = ${tableId}::uuid`;
    await sql`DELETE FROM grids.table_schema_revisions WHERE table_id = ${tableId}::uuid`;
    await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
    if (accessId) await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
  }
}, 30_000);
