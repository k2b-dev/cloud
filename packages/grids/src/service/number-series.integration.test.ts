import { describe, expect } from "bun:test";
import { ok } from "@k2b/stdlib";
import { sql } from "bun";
import { migrate as migrateCoreWorkflows } from "../../../core/src/migrate/core/workflows";
import { projectDocumentTemplates } from "../api/documents-api-shared";
import { toPublicField } from "../api/public-dto";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import * as documents from "./document-core";
import * as documentTemplates from "./document-templates";
import * as fields from "./fields";
import { ALL_RECORD_ACCESS } from "./record-access";
import * as records from "./record-write";
import { get as getTable } from "./tables";

const createFixture = async () => {
  const baseId = testUuid();
  const tableId = testUuid();
  await sql`
    INSERT INTO grids.bases (id, short_id, name)
    VALUES (${baseId}::uuid, ${testShortId("B")}, ${`Number series ${baseId}`})
  `;
  await sql`
    INSERT INTO grids.tables (id, short_id, base_id, name)
    VALUES (${tableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Entries')
  `;
  return { baseId, tableId };
};

const cleanupFixture = async (baseId: string) => {
  void baseId;
};

const numberOf = (value: unknown): number => Number(String(value).replace(/^.*-/, ""));
const renderPdf = async () => ok({ pdf: new TextEncoder().encode("%PDF-1.7\nnumber series"), contentType: "application/pdf" });

describe("durable number series Postgres integration", () => {
  postgresTest(
    "allocates concurrently, burns rollbacks, restores the same series, and versions future formatting",
    async () => {
      await migrateCoreWorkflows();
      await migrate();
      const fixture = await createFixture();
      try {
        const prematureFinalization = await fields.create(
          {
            tableId: fixture.tableId,
            name: "Final number",
            type: "id",
            config: { strategy: "sequence", assignment: "finalization" },
          },
          null,
        );
        expect(prematureFinalization.ok).toBe(false);
        if (!prematureFinalization.ok) expect(prematureFinalization.error.message).toContain("when Finalization is enabled");

        const createdField = await fields.create(
          {
            tableId: fixture.tableId,
            name: "Entry number",
            type: "id",
            config: { strategy: "sequence", prefix: "ENT-", padding: 4 },
          },
          null,
        );
        expect(createdField.ok).toBe(true);
        if (!createdField.ok) throw new Error(createdField.error.message);
        const fieldId = createdField.data.id;

        const parallel = await Promise.all(Array.from({ length: 20 }, () => records.create(fixture.tableId, {}, null, "direct")));
        expect(parallel.every((result) => result.ok)).toBe(true);
        const values = parallel.map((result) => (result.ok ? String(result.data.data[fieldId]) : ""));
        expect(new Set(values).size).toBe(20);
        expect(values.every((value) => /^ENT-[0-9]{4}$/.test(value))).toBe(true);

        const datedField = await fields.create(
          {
            tableId: fixture.tableId,
            name: "Daily number",
            type: "id",
            config: { strategy: "date_sequence", prefix: "DAY-", period: "day", padding: 3 },
          },
          null,
        );
        expect(datedField.ok).toBe(true);
        if (!datedField.ok) throw new Error(datedField.error.message);

        let rolledBackValue = 0;
        let rolledBackDatedValue = 0;
        await expect(
          sql.begin(async (tx) => {
            const result = await records.createInTransaction(tx, fixture.tableId, {}, null, "direct");
            if (!result.ok) throw new Error(result.error.message);
            rolledBackValue = numberOf(result.data.record.data[fieldId]);
            rolledBackDatedValue = numberOf(result.data.record.data[datedField.data.id]);
            throw new Error("intentional rollback");
          }),
        ).rejects.toThrow("intentional rollback");
        const afterRollback = await records.create(fixture.tableId, {}, null, "direct");
        expect(afterRollback.ok).toBe(true);
        if (!afterRollback.ok) throw new Error(afterRollback.error.message);
        expect(numberOf(afterRollback.data.data[fieldId])).toBe(rolledBackValue + 1);
        expect(numberOf(afterRollback.data.data[datedField.data.id])).toBe(rolledBackDatedValue + 1);

        const [beforeDelete] = await sql<Array<{ id: string; lastValue: number }>>`
          SELECT series.id::text, pg_sequence.last_value::int AS "lastValue"
          FROM grids.number_series series
          JOIN grids.number_series_scopes scope ON scope.series_id = series.id AND scope.scope = 'global'
          JOIN pg_sequences pg_sequence ON pg_sequence.schemaname = 'grids' AND pg_sequence.sequencename = scope.sequence_name
          WHERE series.field_id = ${fieldId}::uuid
        `;
        expect((await fields.softDelete(fieldId, null)).ok).toBe(true);
        const [archived] = await sql<Array<{ id: string; archived: boolean }>>`
          SELECT id::text, archived_at IS NOT NULL AS archived FROM grids.number_series WHERE field_id = ${fieldId}::uuid
        `;
        expect(archived).toEqual({ id: beforeDelete!.id, archived: true });
        expect((await fields.restore(fieldId, null)).ok).toBe(true);
        const afterRestore = await records.create(fixture.tableId, {}, null, "direct");
        expect(afterRestore.ok).toBe(true);
        if (!afterRestore.ok) throw new Error(afterRestore.error.message);
        expect(numberOf(afterRestore.data.data[fieldId])).toBe(beforeDelete!.lastValue + 1);

        const updated = await fields.update(fieldId, { config: { strategy: "sequence", prefix: "NEW-", padding: 5 } }, null);
        expect(updated.ok).toBe(true);
        const afterFormat = await records.create(fixture.tableId, {}, null, "direct");
        expect(afterFormat.ok).toBe(true);
        if (!afterFormat.ok) throw new Error(afterFormat.error.message);
        expect(afterFormat.data.data[fieldId]).toMatch(/^NEW-[0-9]{5}$/);
        expect(afterRollback.data.data[fieldId]).toMatch(/^ENT-[0-9]{4}$/);
        const [versions] = await sql<Array<{ count: number }>>`
          SELECT count(*)::int AS count
          FROM grids.number_series_versions version
          JOIN grids.number_series series ON series.id = version.series_id
          WHERE series.field_id = ${fieldId}::uuid
        `;
        expect(versions?.count).toBe(2);
        const publicField = await toPublicField(updated.ok ? updated.data : createdField.data);
        expect(publicField.numberSeries).toMatchObject({ assignment: "creation", state: "active" });
        expect(publicField.numberSeries?.id).toMatch(/^[A-Za-z0-9]{6}$/);
        expect(publicField.numberSeries?.id).not.toBe(beforeDelete!.id);
      } finally {
        await cleanupFixture(fixture.baseId);
      }
    },
    45_000,
  );

  postgresTest(
    "uses the same allocator for Documents and keeps old rendered numbers after pattern changes",
    async () => {
      await migrateCoreWorkflows();
      await migrate();
      const fixture = await createFixture();
      try {
        const record = await records.create(fixture.tableId, {}, null, "direct");
        expect(record.ok).toBe(true);
        if (!record.ok) throw new Error(record.error.message);
        const table = await getTable(fixture.tableId);
        if (!table) throw new Error("table missing");
        const template = await documentTemplates.createTemplate(
          fixture.tableId,
          {
            name: "Receipt",
            source: `from table {${table.shortId}}\nlimit 1`,
            renderer: {
              kind: "html",
              body: "<p>{{ document.number }}</p>",
              numberTemplate: "DOC-{{ series.value }}",
              filenameTemplate: "{{ document.number }}.pdf",
            },
          },
          null,
        );
        expect(template.ok).toBe(true);
        if (!template.ok) throw new Error(template.error.message);
        const first = await documents.createDocumentForRecord({
          template: template.data,
          table,
          recordId: record.data.id,
          actor: { kind: "system" },
          idempotencyKey: `number-series-first-${testUuid()}`,
          recordAccess: ALL_RECORD_ACCESS,
          resolveRecordAccess: async () => ALL_RECORD_ACCESS,
          renderPdf,
        });
        expect(first.ok).toBe(true);
        if (!first.ok) throw new Error(first.error.message);
        expect(first.data.documentNumber).toBe("DOC-1");
        if (template.data.renderer.kind !== "html") throw new Error("expected HTML renderer");

        const updated = await documentTemplates.updateTemplate(
          template.data.id,
          {
            renderer: {
              ...template.data.renderer,
              numberTemplate: "NEW-{{ series.value }}",
            },
          },
          null,
        );
        expect(updated.ok).toBe(true);
        if (!updated.ok) throw new Error(updated.error.message);
        const second = await documents.createDocumentForRecord({
          template: updated.data,
          table,
          recordId: record.data.id,
          actor: { kind: "system" },
          idempotencyKey: `number-series-second-${testUuid()}`,
          recordAccess: ALL_RECORD_ACCESS,
          resolveRecordAccess: async () => ALL_RECORD_ACCESS,
          renderPdf,
        });
        expect(second.ok).toBe(true);
        if (!second.ok) throw new Error(second.error.message);
        expect(second.data.documentNumber).toBe("NEW-2");
        expect((await documents.getDocument(first.data.id))?.documentNumber).toBe("DOC-1");
        const [publicTemplate] = await projectDocumentTemplates([updated.data]);
        expect(publicTemplate?.numberSeries).toMatchObject({ assignment: "creation", state: "active", lastValue: 2 });
        expect(publicTemplate?.numberSeries?.id).toMatch(/^[A-Za-z0-9]{6}$/);

        const profiled = await documentTemplates.updateTemplate(
          template.data.id,
          {
            renderer: {
              kind: "profile",
              id: "de.zugferd.en16931",
              version: 1,
              inputTemplate: "{}",
            },
          },
          null,
        );
        expect(profiled.ok).toBe(true);
        if (!profiled.ok) throw new Error(profiled.error.message);
        expect(profiled.data.renderer).toEqual({
          kind: "profile",
          id: "de.zugferd.en16931",
          version: 1,
          inputTemplate: "{}",
        });
        expect((await projectDocumentTemplates([profiled.data]))[0]?.numberSeries).toBeNull();

        expect((await documentTemplates.removeTemplate(template.data.id, null)).ok).toBe(true);
        const [archived] = await sql<Array<{ id: string; archived: boolean }>>`
          SELECT id::text, archived_at IS NOT NULL AS archived
          FROM grids.number_series WHERE document_template_id = ${template.data.id}::uuid
        `;
        expect(archived?.archived).toBe(true);
        const restored = await documentTemplates.restoreTemplate(template.data.id, null);
        expect(restored.ok).toBe(true);
        const [active] = await sql<Array<{ id: string; archived: boolean }>>`
          SELECT id::text, archived_at IS NOT NULL AS archived
          FROM grids.number_series WHERE document_template_id = ${template.data.id}::uuid
        `;
        expect(active).toEqual({ id: archived!.id, archived: true });
      } finally {
        await cleanupFixture(fixture.baseId);
      }
    },
    45_000,
  );
});
