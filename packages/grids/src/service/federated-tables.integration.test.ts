import { beforeAll, describe, expect, spyOn } from "bun:test";
import { sql } from "bun";
import { postgresTest, testShortId as shortId, testUuid as uuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { parseGridsQueryDsl } from "../query-dsl/parser";
import { previewDslQuery } from "../query-dsl/preview";
import type { DslTableSource } from "../query-dsl/resolver";
import { resolveDslQueryToQueryPlan } from "../query-dsl/resolver";
import { assertFederatedPublication, buildDslSqlRecordSource } from "../query-dsl/sql-record-source";
import { remove as removeBase, restore as restoreBase } from "./bases";
import * as boundedQuery from "./bounded-query";
import * as combinedAudit from "./combined-audit";
import { exportRecords } from "./export";
import {
  captureRevisionScope,
  degradeForTableSchemaChange,
  type FederatedRevisionScope,
  getCurrent,
  getDraft,
  listSourceCandidates,
  publishDraft,
  refreshForSourceTable,
  refreshForTableSchemaChange,
  revokeSource,
  updateDraft,
  validateDraft,
  verifyRevisionScope,
} from "./federated-tables";
import { create as createField, update as updateField } from "./fields";
import { getContent, listFirstImagePreviews, listForRecordField } from "./files";
import { resolveFederatedTargetsForRecordEvent } from "./record-events";
import { listByRecord as listRecordHistory } from "./record-history";
import { createReader } from "./record-read";
import { create as createRecord } from "./record-write";
import { buildRelationLabelCache, lookupRecords } from "./relation-labels";
import { remove as removeTable, restore as restoreTable, update as updateTable } from "./tables";
import type { Field } from "./types";

type Fixture = {
  sourceBaseId: string;
  targetBaseId: string;
  sourceTableId: string;
  targetTableId: string;
  sourceTextFieldId: string;
  targetTextFieldId: string;
  sourceFileFieldId: string;
  targetFileFieldId: string;
  recordId: string;
  fileId: string;
  revisionId: string;
  targetFields: Field[];
};

const fieldFromRow = (row: Record<string, unknown>): Field => ({
  id: row.id as string,
  shortId: row.short_id as string,
  tableId: row.table_id as string,
  name: row.name as string,
  description: null,
  icon: null,
  type: row.type as string,
  config: (row.config as Record<string, unknown> | null) ?? {},
  position: row.position as number,
  required: false,
  presentable: Boolean(row.presentable),
  hideInTable: false,
  defaultValue: null,
  indexed: false,
  uniqueConstraint: false,
  deletedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const loadTableFields = async (tableId: string): Promise<Field[]> => {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id::text, short_id, table_id::text, name, type, config, position, presentable
    FROM grids.fields
    WHERE table_id = ${tableId}::uuid AND deleted_at IS NULL
    ORDER BY position
  `;
  return rows.map(fieldFromRow);
};

const createFixture = async (): Promise<Fixture> => {
  const sourceBaseId = uuid();
  const targetBaseId = uuid();
  const sourceTableId = uuid();
  const targetTableId = uuid();
  const sourceTextFieldId = uuid();
  const targetTextFieldId = uuid();
  const sourceFileFieldId = uuid();
  const targetFileFieldId = uuid();
  const recordId = uuid();
  const fileId = uuid();
  const revisionId = uuid();
  await sql`
    INSERT INTO grids.bases (id, short_id, name)
    VALUES
      (${sourceBaseId}::uuid, ${shortId("S")}, 'Combined source integration'),
      (${targetBaseId}::uuid, ${shortId("T")}, 'Combined target integration')
  `;
  await sql`
    INSERT INTO grids.tables (id, short_id, base_id, kind, name, position, disable_direct_insert)
    VALUES
      (${sourceTableId}::uuid, ${shortId("S")}, ${sourceBaseId}::uuid, 'stored', 'Source', 0, FALSE),
      (${targetTableId}::uuid, ${shortId("C")}, ${targetBaseId}::uuid, 'federated', 'Combined', 0, TRUE)
  `;
  await sql`
    INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position, presentable)
    VALUES
      (${sourceTextFieldId}::uuid, ${shortId("ST")}, ${sourceTableId}::uuid, 'Source name', 'text', '{}'::jsonb, 0, TRUE),
      (${sourceFileFieldId}::uuid, ${shortId("SF")}, ${sourceTableId}::uuid, 'Source file', 'file', '{}'::jsonb, 1, FALSE),
      (${targetTextFieldId}::uuid, ${shortId("CT")}, ${targetTableId}::uuid, 'Name', 'text', '{}'::jsonb, 0, TRUE),
      (${targetFileFieldId}::uuid, ${shortId("CF")}, ${targetTableId}::uuid, 'File', 'file', '{}'::jsonb, 1, FALSE)
  `;
  await sql`
    INSERT INTO grids.records (id, short_id, table_id, data)
    VALUES (${recordId}::uuid, ${shortId("R")}, ${sourceTableId}::uuid, jsonb_build_object(${sourceTextFieldId}::text, 'Mapped value'))
  `;
  await sql`
    INSERT INTO grids.files (id, short_id, filename, mime_type, size_bytes, sha256, bytes)
    VALUES (${fileId}::uuid, ${shortId("FI")}, 'source.png', 'image/png', 5, 'fixture', ${new TextEncoder().encode("hello")})
  `;
  await sql`
    INSERT INTO grids.file_attachments (file_id, record_id, field_id, position)
    VALUES (${fileId}::uuid, ${recordId}::uuid, ${sourceFileFieldId}::uuid, 0)
  `;
  await sql`
    INSERT INTO grids.federated_table_revisions (id, table_id, revision, status, published_at)
    VALUES (${revisionId}::uuid, ${targetTableId}::uuid, 1, 'active', now())
  `;
  await sql`
    INSERT INTO grids.federated_table_sources (revision_id, source_table_id, position, authorized_at)
    VALUES (${revisionId}::uuid, ${sourceTableId}::uuid, 0, now())
  `;
  await sql`
    INSERT INTO grids.federated_field_mappings (revision_id, target_field_id, source_table_id, source_field_id, config)
    VALUES
      (${revisionId}::uuid, ${targetTextFieldId}::uuid, ${sourceTableId}::uuid, ${sourceTextFieldId}::uuid, '{}'::jsonb),
      (${revisionId}::uuid, ${targetFileFieldId}::uuid, ${sourceTableId}::uuid, ${sourceFileFieldId}::uuid, '{}'::jsonb)
  `;
  return {
    sourceBaseId,
    targetBaseId,
    sourceTableId,
    targetTableId,
    sourceTextFieldId,
    targetTextFieldId,
    sourceFileFieldId,
    targetFileFieldId,
    recordId,
    fileId,
    revisionId,
    targetFields: await loadTableFields(targetTableId),
  };
};

const cleanupFixture = async (fixture: Fixture): Promise<void> => {
  await sql`DELETE FROM grids.audit_log WHERE table_id IN (${fixture.sourceTableId}::uuid, ${fixture.targetTableId}::uuid)`;
  await sql`DELETE FROM grids.federated_table_revisions WHERE table_id = ${fixture.targetTableId}::uuid`;
  await sql`DELETE FROM grids.bases WHERE id IN (${fixture.sourceBaseId}::uuid, ${fixture.targetBaseId}::uuid)`;
  await sql`DELETE FROM grids.files WHERE id = ${fixture.fileId}::uuid`;
};

const previewCombined = async (
  fixture: Fixture,
  source: string,
  expectedFederatedRevisionScope?: FederatedRevisionScope,
  context: { tables?: DslTableSource[]; fieldsByTableId?: Record<string, Field[]> } = {},
) => {
  const combinedTable = { kind: "table" as const, id: fixture.targetTableId, shortId: "combined", name: "Combined" };
  const fieldsByTableId = { [fixture.targetTableId]: fixture.targetFields, ...context.fieldsByTableId };
  const parsed = parseGridsQueryDsl(source);
  if (!parsed.ok) throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("; "));
  const resolved = resolveDslQueryToQueryPlan(parsed.ast, {
    currentTable: combinedTable,
    tables: [combinedTable, ...(context.tables ?? [])],
    views: [],
    fieldsByTableId,
  });
  if (!resolved.ok) throw new Error(resolved.diagnostics.map((diagnostic) => diagnostic.message).join("; "));
  const preview = await previewDslQuery(resolved.plan, {
    fieldsByTableId,
    maxRows: 100,
    labelRelationValues: false,
    expectedFederatedRevisionScope,
  });
  if (!preview.ok) throw new Error(preview.error.message);
  return preview.data;
};

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("combined table integration", () => {
  postgresTest("projects source audit and declared mutation answers through the active Combined schema", async () => {
    const fixture = await createFixture();
    const hiddenFieldId = uuid();
    const questionId = uuid();
    const olderAuditId = "00000000-0000-4000-8000-000000000001";
    const privateOnlyAuditId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const newerAuditId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    try {
      await sql`
        UPDATE grids.records
        SET deleted_at = now()
        WHERE id = ${fixture.recordId}::uuid
          AND table_id = ${fixture.sourceTableId}::uuid
      `;
      await sql`
        INSERT INTO grids.audit_log (id, table_id, record_id, action, diff, context, ip, user_agent, created_at)
        VALUES
          (
            ${olderAuditId}::uuid,
            ${fixture.sourceTableId}::uuid,
            ${fixture.recordId}::uuid,
            'updated',
            ${{ [fixture.sourceTextFieldId]: { old: "Initial", new: "Mapped value" } }}::jsonb,
            NULL,
            NULL,
            NULL,
            '2026-01-01T00:00:00Z'::timestamptz
          ),
          (
            ${privateOnlyAuditId}::uuid,
            ${fixture.sourceTableId}::uuid,
            ${fixture.recordId}::uuid,
            'updated',
            ${{ [hiddenFieldId]: { old: "private", new: "still private" } }}::jsonb,
            NULL,
            NULL,
            NULL,
            '2026-01-01T00:00:00Z'::timestamptz
          ),
          (
            ${newerAuditId}::uuid,
            ${fixture.sourceTableId}::uuid,
            ${fixture.recordId}::uuid,
            'deleted',
            ${{
              [fixture.sourceTextFieldId]: { old: "Mapped value", new: null },
              [hiddenFieldId]: { old: "private", new: null },
            }}::jsonb,
            ${{
              version: 1,
              operation: "delete",
              questions: [{ id: questionId, label: "Deletion reason", type: "longtext", required: true }],
              answers: [
                {
                  questionId,
                  label: "Deletion reason",
                  type: "longtext",
                  required: true,
                  value: "Retired after annual inventory audit",
                },
              ],
            }}::jsonb,
            '192.0.2.1',
            'private-agent',
            '2026-01-01T00:00:00Z'::timestamptz
          )
      `;

      const page = await combinedAudit.list({ tableId: fixture.targetTableId, recordId: fixture.recordId, limit: 1 });
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      expect(page.data.items).toHaveLength(1);
      expect(page.data.items[0]?.id).toBe(newerAuditId);
      expect(page.data.nextCursor).not.toBeNull();
      const entry = page.data.items[0]!;
      expect(entry.diff).toEqual({
        [fixture.targetTextFieldId]: { old: "Mapped value", new: null },
      });
      expect(entry.context?.answers[0]?.value).toBe("Retired after annual inventory audit");
      expect(entry.ip).toBeNull();
      expect(entry.userAgent).toBeNull();
      expect(entry.recordDeletedAt).not.toBeNull();
      expect(entry.source).toMatchObject({
        baseName: "Combined source integration",
        tableName: "Source",
      });
      const recordHistory = await listRecordHistory(fixture.targetTableId, fixture.recordId, 1);
      expect(recordHistory[0]).toMatchObject({
        tableId: fixture.targetTableId,
        recordId: fixture.recordId,
        action: "deleted",
      });
      const contextOnly = await combinedAudit.list({
        tableId: fixture.targetTableId,
        recordId: fixture.recordId,
        fieldIds: [],
        limit: 1,
      });
      expect(contextOnly.ok).toBe(true);
      if (contextOnly.ok) {
        expect(contextOnly.data.items[0]?.diff).toBeNull();
        expect(contextOnly.data.items[0]?.context?.answers[0]?.value).toBe("Retired after annual inventory audit");
      }
      const older = await combinedAudit.list({
        tableId: fixture.targetTableId,
        recordId: fixture.recordId,
        limit: 1,
        cursor: page.data.nextCursor,
      });
      expect(older.ok).toBe(true);
      if (older.ok) {
        expect(older.data.items.map((item) => item.action)).toEqual(["updated"]);
        expect(older.data.items[0]?.id).toBe(olderAuditId);
        expect(older.data.nextCursor).toBeNull();
      }
      const tamperedCursor = `${page.data.nextCursor!.slice(0, -1)}${page.data.nextCursor!.endsWith("A") ? "B" : "A"}`;
      const tampered = await combinedAudit.list({
        tableId: fixture.targetTableId,
        recordId: fixture.recordId,
        limit: 1,
        cursor: tamperedCursor,
      });
      expect(tampered.ok).toBe(false);
      if (!tampered.ok) expect(tampered.error.status).toBe(400);
      const mismatchedFieldScope = await combinedAudit.list({
        tableId: fixture.targetTableId,
        recordId: fixture.recordId,
        fieldIds: [],
        limit: 1,
        cursor: page.data.nextCursor,
      });
      expect(mismatchedFieldScope.ok).toBe(false);
      if (!mismatchedFieldScope.ok) expect(mismatchedFieldScope.error.status).toBe(409);
      const mismatchedCursor = await combinedAudit.list({
        tableId: fixture.targetTableId,
        recordId: fixture.recordId,
        action: "updated",
        limit: 1,
        cursor: page.data.nextCursor,
      });
      expect(mismatchedCursor.ok).toBe(false);
      if (!mismatchedCursor.ok) expect(mismatchedCursor.error.status).toBe(409);

      const origin = await combinedAudit.describeRecord(fixture.targetTableId, fixture.recordId);
      expect(origin.ok).toBe(true);
      if (origin.ok) expect(origin.data.deletedAt).not.toBeNull();
      expect(await (await createReader(fixture.targetTableId)).get(fixture.recordId)).toBeNull();
      expect(await (await createReader(fixture.targetTableId, { deleted: "only" })).get(fixture.recordId)).toMatchObject({
        id: fixture.recordId,
        deletedAt: expect.any(String),
      });

      await sql`UPDATE grids.fields SET deleted_at = now() WHERE id = ${fixture.targetTextFieldId}::uuid`;
      const drifted = await combinedAudit.list({ tableId: fixture.targetTableId, recordId: fixture.recordId });
      expect(drifted.ok).toBe(false);
      if (!drifted.ok) expect(drifted.error.status).toBe(409);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("lists source candidates with server-side admin filtering and pagination", async () => {
    const fixture = await createFixture();
    const [user] = await sql<Array<{ id: string }>>`SELECT id::text FROM auth.users ORDER BY id LIMIT 1`;
    if (!user) throw new Error("Combined candidate integration test needs one auth user");
    const accessIds: string[] = [];
    try {
      const [sourceTable] = await sql<Array<{ short_id: string }>>`
        SELECT short_id FROM grids.tables WHERE id = ${fixture.sourceTableId}::uuid
      `;
      if (!sourceTable) throw new Error("Combined source table fixture is missing");
      const hidden = await listSourceCandidates({
        targetTableId: fixture.targetTableId,
        authorization: { subject: { type: "user", userId: user.id }, permissionCap: "admin" },
        q: sourceTable.short_id,
        limit: 1,
      });
      expect(hidden).toEqual({ items: [], total: 0, limit: 1, offset: 0 });

      for (const baseId of [fixture.sourceBaseId, fixture.targetBaseId]) {
        const [access] = await sql<Array<{ id: string }>>`
          INSERT INTO auth.access (user_id, permission)
          VALUES (${user.id}::uuid, 'admin')
          RETURNING id::text
        `;
        if (!access) throw new Error("Failed to create Combined candidate access fixture");
        accessIds.push(access.id);
        await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${access.id}::uuid)`;
      }

      const page = await listSourceCandidates({
        targetTableId: fixture.targetTableId,
        authorization: { subject: { type: "user", userId: user.id }, permissionCap: "admin" },
        q: sourceTable.short_id,
        limit: 1,
        offset: 0,
      });
      expect(page.total).toBe(1);
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.table.id).toBe(fixture.sourceTableId);
      expect(page.items[0]?.fieldCount).toBe(2);
      expect(page.limit).toBe(1);
      expect(page.offset).toBe(0);
    } finally {
      await cleanupFixture(fixture);
      for (const accessId of accessIds) await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
    }
  });

  postgresTest("reads mapped records and files while rejecting writes", async () => {
    const fixture = await createFixture();
    try {
      const source = await buildDslSqlRecordSource(fixture.targetTableId, { [fixture.targetTableId]: fixture.targetFields });
      expect(source).not.toBeNull();
      const rows = await sql<Array<{ id: string; data: Record<string, unknown> }>>`
        SELECT id::text, data
        FROM ${source!.relation} combined_record
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.data[fixture.targetTextFieldId]).toBe("Mapped value");

      const files = await listForRecordField({
        tableId: fixture.targetTableId,
        recordId: fixture.recordId,
        fieldId: fixture.targetFileFieldId,
      });
      expect(files.ok).toBe(true);
      if (files.ok) {
        expect(files.data).toHaveLength(1);
        expect(files.data[0]?.id).toBe(fixture.fileId);
        expect(files.data[0]?.fieldId).toBe(fixture.targetFileFieldId);
      }

      const content = await getContent({
        tableId: fixture.targetTableId,
        recordId: fixture.recordId,
        fieldId: fixture.targetFileFieldId,
        fileId: fixture.fileId,
      });
      expect(content.ok).toBe(true);
      if (content.ok) {
        expect(content.data.fieldId).toBe(fixture.targetFileFieldId);
        expect(new TextDecoder().decode(content.data.bytes)).toBe("hello");
      }

      const previews = await listFirstImagePreviews({
        tableId: fixture.targetTableId,
        recordIds: [fixture.recordId],
        fieldIds: [fixture.targetFileFieldId],
      });
      expect(previews[fixture.recordId]?.[fixture.targetFileFieldId]?.fileId).toBe(fixture.fileId);

      const write = await createRecord(fixture.targetTableId, { [fixture.targetTextFieldId]: "No" }, null, "direct");
      expect(write.ok).toBe(false);
      if (!write.ok) expect(write.error.message).toContain("read-only");
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("unifies multiple sources with explicit option maps and typed missing values", async () => {
    const fixture = await createFixture();
    const secondBaseId = uuid();
    const secondTableId = uuid();
    const secondTextFieldId = uuid();
    const firstStatusFieldId = uuid();
    const secondStatusFieldId = uuid();
    const targetStatusFieldId = uuid();
    const targetOptionalFieldId = uuid();
    const firstOptionId = uuid();
    const secondOptionId = uuid();
    const canonicalOptionId = uuid();
    try {
      await sql`
        INSERT INTO grids.bases (id, short_id, name)
        VALUES (${secondBaseId}::uuid, ${shortId("S")}, 'Second combined source')
      `;
      await sql`
        INSERT INTO grids.tables (id, short_id, base_id, kind, name, position, disable_direct_insert)
        VALUES (${secondTableId}::uuid, ${shortId("S")}, ${secondBaseId}::uuid, 'stored', 'Second source', 0, FALSE)
      `;
      await sql`
        INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position, presentable)
        VALUES
          (${firstStatusFieldId}::uuid, ${shortId("SS")}, ${fixture.sourceTableId}::uuid, 'Status', 'select', ${{
            multiple: false,
            options: [{ id: firstOptionId, label: "Open" }],
          }}::jsonb, 2, FALSE),
          (${secondTextFieldId}::uuid, ${shortId("ST")}, ${secondTableId}::uuid, 'Label', 'text', '{}'::jsonb, 0, TRUE),
          (${secondStatusFieldId}::uuid, ${shortId("SS")}, ${secondTableId}::uuid, 'State', 'select', ${{
            multiple: false,
            options: [{ id: secondOptionId, label: "Ready" }],
          }}::jsonb, 1, FALSE),
          (${targetStatusFieldId}::uuid, ${shortId("CS")}, ${fixture.targetTableId}::uuid, 'Status', 'select', ${{
            multiple: false,
            options: [{ id: canonicalOptionId, label: "Available" }],
          }}::jsonb, 2, FALSE),
          (${targetOptionalFieldId}::uuid, ${shortId("CO")}, ${fixture.targetTableId}::uuid, 'Optional note', 'text', '{}'::jsonb, 3, FALSE)
      `;
      await sql`
        UPDATE grids.records
        SET data = data || jsonb_build_object(${firstStatusFieldId}::text, jsonb_build_array(${firstOptionId}::text))
        WHERE id = ${fixture.recordId}::uuid
      `;
      await sql`
        INSERT INTO grids.records (id, short_id, table_id, data)
        VALUES (
          ${uuid()}::uuid,
          ${shortId("R")},
          ${secondTableId}::uuid,
          jsonb_build_object(
            ${secondTextFieldId}::text, 'Second value',
            ${secondStatusFieldId}::text, jsonb_build_array(${secondOptionId}::text)
          )
        )
      `;
      await sql`
        INSERT INTO grids.federated_table_sources (revision_id, source_table_id, position, authorized_at)
        VALUES (${fixture.revisionId}::uuid, ${secondTableId}::uuid, 1, now())
      `;
      await sql`
        INSERT INTO grids.federated_field_mappings (revision_id, target_field_id, source_table_id, source_field_id, config)
        VALUES
          (${fixture.revisionId}::uuid, ${targetStatusFieldId}::uuid, ${fixture.sourceTableId}::uuid, ${firstStatusFieldId}::uuid,
            ${{ optionMap: { [firstOptionId]: canonicalOptionId } }}::jsonb),
          (${fixture.revisionId}::uuid, ${fixture.targetTextFieldId}::uuid, ${secondTableId}::uuid, ${secondTextFieldId}::uuid, '{}'::jsonb),
          (${fixture.revisionId}::uuid, ${targetStatusFieldId}::uuid, ${secondTableId}::uuid, ${secondStatusFieldId}::uuid,
            ${{ optionMap: { [secondOptionId]: canonicalOptionId } }}::jsonb)
      `;

      fixture.targetFields = await loadTableFields(fixture.targetTableId);
      const source = await buildDslSqlRecordSource(fixture.targetTableId, { [fixture.targetTableId]: fixture.targetFields });
      expect(source).not.toBeNull();
      const rawRows = await sql<Array<{ source_base_id: string; data: Record<string, unknown> }>>`
        SELECT source_base_id::text, data
        FROM ${source!.relation} combined_record
        ORDER BY data->>${fixture.targetTextFieldId}
      `;
      expect(rawRows.map((row) => row.source_base_id)).toEqual([fixture.sourceBaseId, secondBaseId]);
      expect(rawRows.map((row) => row.data[targetStatusFieldId])).toEqual([[canonicalOptionId], [canonicalOptionId]]);
      expect(rawRows.every((row) => !(targetOptionalFieldId in row.data))).toBe(true);

      const preview = await previewCombined(fixture, `from table Combined\nselect Name, Status, "Optional note"\nsort Name asc`);
      expect(preview.mode).toBe("rows");
      expect(preview.rows.map((row) => row.values.q_col_0)).toEqual(["Mapped value", "Second value"]);
      expect(preview.rows.map((row) => row.values.q_col_1)).toEqual([[canonicalOptionId], [canonicalOptionId]]);
      expect(preview.rows.map((row) => row.values.q_col_2)).toEqual([null, null]);
    } finally {
      await cleanupFixture(fixture);
      await sql`DELETE FROM grids.bases WHERE id = ${secondBaseId}::uuid`;
    }
  });

  postgresTest("runs native GQL filtering, sorting, grouping, and aggregates", async () => {
    const fixture = await createFixture();
    try {
      const textField = fixture.targetFields.find((field) => field.id === fixture.targetTextFieldId);
      if (!textField) throw new Error("Missing combined text field");
      await sql`
        INSERT INTO grids.records (id, short_id, table_id, data)
        VALUES
          (${uuid()}::uuid, ${shortId("R")}, ${fixture.sourceTableId}::uuid, jsonb_build_object(${fixture.sourceTextFieldId}::text, 'Mapped second')),
          (${uuid()}::uuid, ${shortId("R")}, ${fixture.sourceTableId}::uuid, jsonb_build_object(${fixture.sourceTextFieldId}::text, 'Other'))
      `;
      const rows = await previewCombined(
        fixture,
        `from table Combined\nselect {${textField.shortId}} as label\nwhere icontains({${textField.shortId}}, 'mapped')\nsort label asc`,
      );
      expect(rows.mode).toBe("rows");
      expect(rows.rows.map((row) => row.values.q_col_0)).toEqual(["Mapped second", "Mapped value"]);

      const searched = await previewCombined(
        fixture,
        `from table Combined\nselect {${textField.shortId}}\nsearch 'mapped'\nsort {${textField.shortId}} asc`,
      );
      expect(searched.mode).toBe("rows");
      expect(searched.rows.map((row) => row.values.q_col_0)).toEqual(["Mapped second", "Mapped value"]);

      const pushedSource = await buildDslSqlRecordSource(
        fixture.targetTableId,
        { [fixture.targetTableId]: fixture.targetFields },
        {
          filter: {
            fieldId: fixture.targetTextFieldId,
            op: "equals",
            value: "Mapped value",
          },
        },
      );
      const pushedRows = await sql<Array<{ id: string }>>`
        SELECT id::text
        FROM ${pushedSource!.relation} combined_record
      `;
      expect(pushedRows.map((row) => row.id)).toEqual([fixture.recordId]);

      const groups = await previewCombined(fixture, `from table Combined\ngroup by {${textField.shortId}}\naggregate count(*) as total`);
      expect(groups.mode).toBe("groups");
      expect(groups.rows).toHaveLength(3);
      expect(groups.rows.every((row) => Number(row.values["*__count"]) === 1)).toBe(true);

      const nameLength = await createField(
        {
          tableId: fixture.targetTableId,
          name: "Name length",
          type: "formula",
          config: { expression: "LEN(Name)" },
        },
        null,
      );
      expect(nameLength.ok).toBe(true);
      if (!nameLength.ok) throw new Error(nameLength.error.message);
      fixture.targetFields = await loadTableFields(fixture.targetTableId);
      const formulaCounts = await previewCombined(
        fixture,
        `from table Combined\naggregate count({${nameLength.data.shortId}}) as present, countEmpty({${nameLength.data.shortId}}) as empty`,
      );
      expect(formulaCounts.mode).toBe("groups");
      expect(Number(formulaCounts.rows[0]?.values.present__count)).toBe(3);
      expect(Number(formulaCounts.rows[0]?.values.empty__countEmpty)).toBe(0);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("preserves deleted-record semantics across every physical source", async () => {
    const fixture = await createFixture();
    const deletedRecordId = uuid();
    try {
      await sql`
        INSERT INTO grids.records (id, short_id, table_id, data, deleted_at)
        VALUES (
          ${deletedRecordId}::uuid,
          ${shortId("R")},
          ${fixture.sourceTableId}::uuid,
          jsonb_build_object(${fixture.sourceTextFieldId}::text, 'Deleted value'),
          now()
        )
      `;

      const live = await previewCombined(fixture, `from table Combined\nselect Name`);
      expect(live.rows.map((row) => row.values.q_col_0)).toEqual(["Mapped value"]);

      const all = await previewCombined(fixture, `from table Combined\nselect Name\ninclude deleted\nsort Name asc`);
      expect(all.rows.map((row) => row.values.q_col_0)).toEqual(["Deleted value", "Mapped value"]);

      const deleted = await previewCombined(fixture, `from table Combined\nselect Name\ndeleted only`);
      expect(deleted.rows.map((row) => row.recordId)).toEqual([deletedRecordId]);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("uses canonical relation mappings for labels, lookup, and native GQL joins", async () => {
    const fixture = await createFixture();
    const relationTableId = uuid();
    const relationNameFieldId = uuid();
    const relationRecordId = uuid();
    const sourceRelationFieldId = uuid();
    const targetRelationFieldId = uuid();
    try {
      await sql`
        INSERT INTO grids.tables (id, short_id, base_id, kind, name, position)
        VALUES (${relationTableId}::uuid, ${shortId("R")}, ${fixture.sourceBaseId}::uuid, 'stored', 'Categories', 1)
      `;
      await sql`
        INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position, presentable)
        VALUES
          (${relationNameFieldId}::uuid, ${shortId("RN")}, ${relationTableId}::uuid, 'Category', 'text', '{}'::jsonb, 0, TRUE),
          (${sourceRelationFieldId}::uuid, ${shortId("SR")}, ${fixture.sourceTableId}::uuid, 'Source category', 'relation', ${{
            targetTableId: relationTableId,
            cardinality: "single",
          }}::jsonb, 2, FALSE),
          (${targetRelationFieldId}::uuid, ${shortId("CR")}, ${fixture.targetTableId}::uuid, 'Category', 'relation', ${{
            targetTableId: relationTableId,
            cardinality: "single",
          }}::jsonb, 2, FALSE)
      `;
      await sql`
        INSERT INTO grids.records (id, short_id, table_id, data)
        VALUES (${relationRecordId}::uuid, ${shortId("R")}, ${relationTableId}::uuid, jsonb_build_object(${relationNameFieldId}::text, 'Hardware'))
      `;
      await sql`
        INSERT INTO grids.record_links (from_record_id, from_field_id, to_record_id, position)
        VALUES (${fixture.recordId}::uuid, ${sourceRelationFieldId}::uuid, ${relationRecordId}::uuid, 0)
      `;
      await sql`
        INSERT INTO grids.federated_field_mappings (revision_id, target_field_id, source_table_id, source_field_id, config)
        VALUES (${fixture.revisionId}::uuid, ${targetRelationFieldId}::uuid, ${fixture.sourceTableId}::uuid, ${sourceRelationFieldId}::uuid, '{}'::jsonb)
      `;

      fixture.targetFields = await loadTableFields(fixture.targetTableId);
      const relationFields = await loadTableFields(relationTableId);
      const labels = await buildRelationLabelCache(
        [
          {
            id: fixture.recordId,
            shortId: "REC001",
            tableId: fixture.targetTableId,
            data: { [targetRelationFieldId]: [relationRecordId] },
            version: 1,
            deletedAt: null,
            createdBy: null,
            updatedBy: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        fixture.targetFields,
      );
      expect(labels[relationRecordId]).toBe("Hardware");

      const lookup = await lookupRecords({ targetTableId: fixture.targetTableId, q: "mapped" });
      expect(lookup.items).toEqual([{ id: fixture.recordId, label: "Mapped value" }]);

      const joined = await previewCombined(
        fixture,
        `from table Combined\njoin table Categories as category on Category = category.id\nselect Name, category.Category`,
        undefined,
        {
          tables: [{ kind: "table", id: relationTableId, shortId: "categories", name: "Categories" }],
          fieldsByTableId: { [relationTableId]: relationFields },
        },
      );
      expect(joined.rows).toHaveLength(1);
      expect(joined.rows[0]?.values.q_col_1).toBe("Hardware");

      const reverseJoined = await previewCombined(
        fixture,
        `from table Categories as category\njoin table Combined as item on item.Category = category.id\nselect category.Category, item.Name`,
        undefined,
        {
          tables: [{ kind: "table", id: relationTableId, shortId: "categories", name: "Categories" }],
          fieldsByTableId: { [relationTableId]: relationFields },
        },
      );
      expect(reverseJoined.rows).toHaveLength(1);
      expect(reverseJoined.rows[0]?.values.q_col_1).toBe("Mapped value");
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("invalidates combined tables only for mapped source changes", async () => {
    const fixture = await createFixture();
    const unmappedFieldId = uuid();
    const event = (changedFieldIds: string[]) => ({
      v: 1 as const,
      type: "record.updated" as const,
      baseId: fixture.sourceBaseId,
      tableId: fixture.sourceTableId,
      recordId: fixture.recordId,
      version: 2,
      changedFieldIds,
      actorId: null,
      occurredAt: new Date().toISOString(),
    });
    try {
      const mapped = await resolveFederatedTargetsForRecordEvent(event([fixture.sourceTextFieldId]));
      expect(mapped).toEqual([
        {
          baseId: fixture.targetBaseId,
          tableId: fixture.targetTableId,
          changedFieldIds: [fixture.targetTextFieldId],
        },
      ]);

      expect(await resolveFederatedTargetsForRecordEvent(event([unmappedFieldId]))).toEqual([]);
      const broad = await resolveFederatedTargetsForRecordEvent(event([]));
      expect(broad).toHaveLength(1);
      expect(new Set(broad[0]?.changedFieldIds)).toEqual(new Set([fixture.targetTextFieldId, fixture.targetFileFieldId]));

      const sourceFormula = await createField(
        {
          tableId: fixture.sourceTableId,
          name: "Source name length",
          type: "formula",
          config: { expression: 'LEN("Source name")' },
        },
        null,
      );
      const targetFormula = await createField({ tableId: fixture.targetTableId, name: "Name length", type: "number" }, null);
      expect(sourceFormula.ok && targetFormula.ok).toBe(true);
      if (!sourceFormula.ok || !targetFormula.ok) throw new Error("Failed to create computed invalidation fixture");
      await sql`
        INSERT INTO grids.federated_field_mappings (revision_id, target_field_id, source_table_id, source_field_id, config)
        VALUES (
          ${fixture.revisionId}::uuid,
          ${targetFormula.data.id}::uuid,
          ${fixture.sourceTableId}::uuid,
          ${sourceFormula.data.id}::uuid,
          '{}'::jsonb
        )
      `;
      const computed = await resolveFederatedTargetsForRecordEvent(event([unmappedFieldId]));
      expect(computed).toEqual([
        {
          baseId: fixture.targetBaseId,
          tableId: fixture.targetTableId,
          changedFieldIds: [targetFormula.data.id],
        },
      ]);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("fails closed when a compiled publication is revoked with no source rows", async () => {
    const fixture = await createFixture();
    try {
      await sql`DELETE FROM grids.file_attachments WHERE record_id = ${fixture.recordId}::uuid`;
      await sql`DELETE FROM grids.files WHERE id = ${fixture.fileId}::uuid`;
      await sql`DELETE FROM grids.records WHERE id = ${fixture.recordId}::uuid`;
      const source = await buildDslSqlRecordSource(fixture.targetTableId, { [fixture.targetTableId]: fixture.targetFields });
      expect(source).not.toBeNull();
      await sql`
        UPDATE grids.federated_table_sources
        SET revoked_at = now()
        WHERE revision_id = ${fixture.revisionId}::uuid
      `;
      // With no source rows the guard embedded in the relation never runs:
      // Postgres prunes a subplan whose output cannot contribute rows. Every
      // reader therefore asserts the publication as its own statement, which is
      // what this covers.
      let queryError: unknown = null;
      try {
        await assertFederatedPublication(source!);
        await sql`SELECT * FROM ${source!.relation} combined_record`;
      } catch (error) {
        queryError = error;
      }
      expect(queryError).toBeInstanceOf(Error);
      expect((queryError as Error).message).toContain("combined table publication changed");
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("rejects a pinned query scope after the combined publication changes", async () => {
    const fixture = await createFixture();
    const replacementRevisionId = uuid();
    try {
      const scope = await captureRevisionScope([fixture.targetTableId]);
      expect(scope).toHaveLength(1);
      expect((await verifyRevisionScope(scope)).ok).toBe(true);
      const first = await previewCombined(fixture, `from table Combined\nselect Name`, scope);
      expect(first.mode).toBe("rows");

      await sql.begin(async (tx) => {
        await tx`
          UPDATE grids.federated_table_revisions
          SET status = 'superseded', updated_at = now()
          WHERE id = ${fixture.revisionId}::uuid
        `;
        await tx`
          INSERT INTO grids.federated_table_revisions (id, table_id, revision, status, published_at)
          VALUES (${replacementRevisionId}::uuid, ${fixture.targetTableId}::uuid, 2, 'active', now())
        `;
        await tx`
          INSERT INTO grids.federated_table_sources (revision_id, source_table_id, position, authorized_at)
          SELECT ${replacementRevisionId}::uuid, source_table_id, position, authorized_at
          FROM grids.federated_table_sources
          WHERE revision_id = ${fixture.revisionId}::uuid
        `;
        await tx`
          INSERT INTO grids.federated_field_mappings (revision_id, target_field_id, source_table_id, source_field_id, config)
          SELECT ${replacementRevisionId}::uuid, target_field_id, source_table_id, source_field_id, config
          FROM grids.federated_field_mappings
          WHERE revision_id = ${fixture.revisionId}::uuid
        `;
      });

      const verified = await verifyRevisionScope(scope);
      expect(verified.ok).toBe(false);
      if (!verified.ok) expect(verified.error.message).toContain("publication changed");
      await expect(previewCombined(fixture, `from table Combined\nselect Name`, scope)).rejects.toThrow("publication changed");
      await expect(
        listFirstImagePreviews({
          tableId: fixture.targetTableId,
          recordIds: [],
          fieldIds: [],
          expectedFederatedRevisionScope: scope,
        }),
      ).rejects.toThrow("publication changed");
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("invalidates pinned scopes when the canonical schema changes", async () => {
    const fixture = await createFixture();
    try {
      const scope = await captureRevisionScope([fixture.targetTableId]);
      expect(scope).toHaveLength(1);

      const updated = await updateField(fixture.targetTextFieldId, { name: "Canonical name" }, null);
      expect(updated.ok).toBe(true);
      expect((await getCurrent(fixture.targetTableId))?.status).toBe("active");

      const verified = await verifyRevisionScope(scope);
      expect(verified.ok).toBe(false);
      if (!verified.ok) expect(verified.error.message).toContain("publication changed");
      await expect(previewCombined(fixture, `from table Combined\nselect Name`, scope)).rejects.toThrow("publication changed");
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("invalidates pinned scopes when a mapped source schema changes", async () => {
    const fixture = await createFixture();
    try {
      const scope = await captureRevisionScope([fixture.targetTableId]);
      expect(scope).toHaveLength(1);

      const updated = await updateField(fixture.sourceTextFieldId, { name: "Published source name" }, null);
      expect(updated.ok).toBe(true);
      expect((await getCurrent(fixture.targetTableId))?.status).toBe("active");

      const verified = await verifyRevisionScope(scope);
      expect(verified.ok).toBe(false);
      if (!verified.ok) expect(verified.error.message).toContain("publication changed");
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("serializes source-schema refresh behind the schema mutation", async () => {
    const fixture = await createFixture();
    let releaseMutation = () => {};
    let mutationLocked = () => {};
    const waitForRelease = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const waitForLock = new Promise<void>((resolve) => {
      mutationLocked = resolve;
    });
    try {
      const mutation = sql.begin(async (tx) => {
        await degradeForTableSchemaChange(fixture.sourceTableId, null, tx);
        await tx`
          UPDATE grids.fields
          SET deleted_at = now(), updated_at = now()
          WHERE id = ${fixture.sourceTextFieldId}::uuid
        `;
        mutationLocked();
        await waitForRelease;
      });
      await waitForLock;

      let refreshSettled = false;
      const refresh = refreshForTableSchemaChange(fixture.sourceTableId, null).finally(() => {
        refreshSettled = true;
      });
      await Bun.sleep(20);
      expect(refreshSettled).toBe(false);

      releaseMutation();
      await mutation;
      await refresh;
      const current = await getCurrent(fixture.targetTableId);
      expect(current?.status).toBe("degraded");
      expect(current?.diagnostics.some((diagnostic) => diagnostic.code === "source_field_missing")).toBe(true);
    } finally {
      releaseMutation();
      await cleanupFixture(fixture);
    }
  });

  postgresTest("rejects stale draft updates instead of overwriting a concurrent editor", async () => {
    const fixture = await createFixture();
    const draftId = uuid();
    try {
      await sql`
        INSERT INTO grids.federated_table_revisions (id, table_id, revision, status)
        VALUES (${draftId}::uuid, ${fixture.targetTableId}::uuid, 2, 'draft')
      `;
      await sql`
        INSERT INTO grids.federated_table_sources (revision_id, source_table_id, position)
        VALUES (${draftId}::uuid, ${fixture.sourceTableId}::uuid, 0)
      `;
      await sql`
        INSERT INTO grids.federated_field_mappings (revision_id, target_field_id, source_table_id, source_field_id, config)
        VALUES
          (${draftId}::uuid, ${fixture.targetTextFieldId}::uuid, ${fixture.sourceTableId}::uuid, ${fixture.sourceTextFieldId}::uuid, '{}'::jsonb),
          (${draftId}::uuid, ${fixture.targetFileFieldId}::uuid, ${fixture.sourceTableId}::uuid, ${fixture.sourceFileFieldId}::uuid, '{}'::jsonb)
      `;
      const draft = await getDraft(fixture.targetTableId);
      if (!draft) throw new Error("Combined draft fixture is incomplete");
      const input = {
        sourceTableIds: [fixture.sourceTableId],
        mappings: [
          {
            targetFieldId: fixture.targetTextFieldId,
            sourceTableId: fixture.sourceTableId,
            sourceFieldId: fixture.sourceTextFieldId,
            config: {},
          },
          {
            targetFieldId: fixture.targetFileFieldId,
            sourceTableId: fixture.sourceTableId,
            sourceFieldId: fixture.sourceFileFieldId,
            config: {},
          },
        ],
      };

      const first = await updateDraft(fixture.targetTableId, input, draft.revisionToken, null, null);
      expect(first.ok).toBe(true);
      const stale = await updateDraft(fixture.targetTableId, input, draft.revisionToken, null, null);
      expect(stale.ok).toBe(false);
      if (!stale.ok) {
        expect(stale.error.status).toBe(409);
        expect(stale.error.message).toContain("reload");
      }
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("rechecks source administration when publishing broader scope and revoking access", async () => {
    const fixture = await createFixture();
    const changedSourceFieldId = uuid();
    const draftId = uuid();
    const [user] = await sql<Array<{ id: string }>>`SELECT id::text FROM auth.users ORDER BY id LIMIT 1`;
    if (!user) throw new Error("Combined publication integration test needs one auth user");
    const accessIds: string[] = [];
    const addBaseAdmin = async (baseId: string): Promise<string> => {
      const [access] = await sql<Array<{ id: string }>>`
        INSERT INTO auth.access (user_id, permission)
        VALUES (${user.id}::uuid, 'admin')
        RETURNING id::text
      `;
      if (!access) throw new Error("Failed to create Combined publication access fixture");
      accessIds.push(access.id);
      await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${access.id}::uuid)`;
      return access.id;
    };
    let sourceAccessId: string | null = null;
    try {
      await sql`
        INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
        VALUES (${changedSourceFieldId}::uuid, ${shortId("ST")}, ${fixture.sourceTableId}::uuid, 'Published name', 'text', '{}'::jsonb, 2)
      `;
      await sql`
        INSERT INTO grids.federated_table_revisions (id, table_id, revision, status)
        VALUES (${draftId}::uuid, ${fixture.targetTableId}::uuid, 2, 'draft')
      `;
      await sql`
        INSERT INTO grids.federated_table_sources (revision_id, source_table_id, position)
        VALUES (${draftId}::uuid, ${fixture.sourceTableId}::uuid, 0)
      `;
      await sql`
        INSERT INTO grids.federated_field_mappings (revision_id, target_field_id, source_table_id, source_field_id, config)
        VALUES
          (${draftId}::uuid, ${fixture.targetTextFieldId}::uuid, ${fixture.sourceTableId}::uuid, ${changedSourceFieldId}::uuid, '{}'::jsonb),
          (${draftId}::uuid, ${fixture.targetFileFieldId}::uuid, ${fixture.sourceTableId}::uuid, ${fixture.sourceFileFieldId}::uuid, '{}'::jsonb)
      `;
      await addBaseAdmin(fixture.targetBaseId);
      sourceAccessId = await addBaseAdmin(fixture.sourceBaseId);
      const draft = await getDraft(fixture.targetTableId);
      const current = await getCurrent(fixture.targetTableId);
      if (!draft || !current) throw new Error("Combined publication fixture is incomplete");
      const expected = {
        draftId: draft.id,
        draftToken: draft.revisionToken,
        currentId: current.id,
        currentToken: current.revisionToken,
      };
      const authorization = {
        subject: { type: "user" as const, userId: user.id },
        permissionCap: "admin" as const,
      };
      const draftInput = {
        sourceTableIds: draft.sources.map((source) => source.sourceTableId),
        mappings: draft.mappings.map((mapping) => ({
          targetFieldId: mapping.targetFieldId,
          sourceTableId: mapping.sourceTableId,
          sourceFieldId: mapping.sourceFieldId,
          config: mapping.config,
        })),
      };

      await sql`DELETE FROM auth.access WHERE id = ${sourceAccessId}::uuid`;
      const deniedUpdate = await updateDraft(fixture.targetTableId, draftInput, draft.revisionToken, user.id, authorization);
      expect(deniedUpdate.ok).toBe(false);
      if (!deniedUpdate.ok) expect(deniedUpdate.error.message).toContain("every base");
      const deniedPublish = await publishDraft(fixture.targetTableId, user.id, authorization, expected);
      expect(deniedPublish.ok).toBe(false);
      if (!deniedPublish.ok) expect(deniedPublish.error.message).toContain("source base");

      const retainedUpdate = await updateDraft(
        fixture.targetTableId,
        {
          sourceTableIds: [],
          retainedSourceIds: [draft.sources[0]!.id],
          mappings: [],
        },
        draft.revisionToken,
        user.id,
        authorization,
      );
      expect(retainedUpdate.ok).toBe(true);
      if (!retainedUpdate.ok) throw new Error(retainedUpdate.error.message);

      sourceAccessId = await addBaseAdmin(fixture.sourceBaseId);
      const published = await publishDraft(fixture.targetTableId, user.id, authorization, {
        ...expected,
        draftToken: retainedUpdate.data.revisionToken,
      });
      expect(published.ok).toBe(true);

      await sql`DELETE FROM auth.access WHERE id = ${sourceAccessId}::uuid`;
      const deniedRevoke = await revokeSource(fixture.targetTableId, fixture.sourceTableId, user.id, authorization);
      expect(deniedRevoke.ok).toBe(false);
      if (!deniedRevoke.ok) expect(deniedRevoke.error.message).toContain("source base");

      sourceAccessId = await addBaseAdmin(fixture.sourceBaseId);
      const revoked = await revokeSource(fixture.targetTableId, fixture.sourceTableId, user.id, authorization);
      expect(revoked.ok).toBe(true);
      expect((await getCurrent(fixture.targetTableId))?.status).toBe("degraded");
      await refreshForSourceTable(fixture.sourceTableId, user.id);
      const refreshed = await getCurrent(fixture.targetTableId);
      expect(refreshed?.status).toBe("degraded");
      expect(refreshed?.diagnostics.some((diagnostic) => diagnostic.code === "source_access_revoked")).toBe(true);
      const auditRows = await sql<Array<{ diff: unknown }>>`
        SELECT diff
        FROM grids.audit_log
        WHERE table_id = ${fixture.targetTableId}::uuid
          AND action LIKE 'federation.%'
      `;
      const targetAudit = JSON.stringify(auditRows);
      expect(targetAudit).not.toContain(fixture.sourceTableId);
      expect(targetAudit).not.toContain(changedSourceFieldId);
    } finally {
      await cleanupFixture(fixture);
      for (const accessId of accessIds) await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
    }
  });

  postgresTest("does not publish after concurrent group-admin removal", async () => {
    const fixture = await createFixture();
    const draftId = uuid();
    const [user] = await sql<Array<{ id: string; provider: "local" | "ipa" }>>`
      SELECT id::text, provider FROM auth.users ORDER BY id LIMIT 1
    `;
    if (!user) throw new Error("Combined publication integration test needs one auth user");
    const groupId = uuid();
    const accessId = uuid();
    let releaseRemoval = () => {};
    let membershipRemoved = () => {};
    const waitForRelease = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    const waitForRemoval = new Promise<void>((resolve) => {
      membershipRemoved = resolve;
    });
    try {
      await sql`
        INSERT INTO grids.federated_table_revisions (id, table_id, revision, status)
        VALUES (${draftId}::uuid, ${fixture.targetTableId}::uuid, 2, 'draft')
      `;
      await sql`
        INSERT INTO grids.federated_table_sources (revision_id, source_table_id, position)
        SELECT ${draftId}::uuid, source_table_id, position
        FROM grids.federated_table_sources
        WHERE revision_id = ${fixture.revisionId}::uuid
      `;
      await sql`
        INSERT INTO grids.federated_field_mappings (revision_id, target_field_id, source_table_id, source_field_id, config)
        SELECT ${draftId}::uuid, target_field_id, source_table_id, source_field_id, config
        FROM grids.federated_field_mappings
        WHERE revision_id = ${fixture.revisionId}::uuid
      `;
      await sql`
        INSERT INTO auth.groups (id, cn, provider, name)
        VALUES (${groupId}::uuid, ${`combined-publisher-${shortId("G")}`}, ${user.provider}, 'Combined publishers')
      `;
      await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${user.id}::uuid, ${groupId}::uuid)`;
      await sql`
        INSERT INTO auth.access (id, group_id, permission)
        VALUES (${accessId}::uuid, ${groupId}::uuid, 'admin')
      `;
      await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${fixture.targetBaseId}::uuid, ${accessId}::uuid)`;
      const draft = await getDraft(fixture.targetTableId);
      const current = await getCurrent(fixture.targetTableId);
      if (!draft || !current) throw new Error("Combined publication fixture is incomplete");

      const removal = sql.begin(async (tx) => {
        await tx`DELETE FROM auth.user_groups_v2 WHERE user_id = ${user.id}::uuid AND group_id = ${groupId}::uuid`;
        membershipRemoved();
        await waitForRelease;
      });
      await waitForRemoval;
      const publication = publishDraft(
        fixture.targetTableId,
        user.id,
        { subject: { type: "user", userId: user.id }, permissionCap: "admin" },
        {
          draftId: draft.id,
          draftToken: draft.revisionToken,
          currentId: current.id,
          currentToken: current.revisionToken,
        },
      );
      await Bun.sleep(20);
      releaseRemoval();
      await removal;
      const result = await publication;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("combined table base");
      expect((await getCurrent(fixture.targetTableId))?.id).toBe(fixture.revisionId);
    } finally {
      releaseRemoval();
      await cleanupFixture(fixture);
      await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
      await sql`DELETE FROM auth.groups WHERE id = ${groupId}::uuid`;
    }
  });

  postgresTest("keeps combined table and canonical fields read-only", async () => {
    const fixture = await createFixture();
    try {
      const tableUpdate = await updateTable(
        fixture.targetTableId,
        {
          disableDirectInsert: false,
          auditPolicy: {
            delete: {
              enabled: true,
              questions: [{ id: uuid(), type: "text", label: "Reason", required: true }],
            },
          },
        },
        null,
      );
      expect(tableUpdate.ok).toBe(true);
      if (tableUpdate.ok) {
        expect(tableUpdate.data.disableDirectInsert).toBe(true);
        expect(tableUpdate.data.auditPolicy).toEqual({});
      }

      const createConstraint = await createField({ tableId: fixture.targetTableId, name: "Required", type: "text", required: true }, null);
      expect(createConstraint.ok).toBe(false);
      if (!createConstraint.ok) expect(createConstraint.error.message).toContain("write constraints");

      const updateConstraint = await updateField(fixture.targetTextFieldId, { indexed: true }, null);
      expect(updateConstraint.ok).toBe(false);
      if (!updateConstraint.ok) expect(updateConstraint.error.message).toContain("write constraints");

      const invalidFormula = await createField(
        {
          tableId: fixture.targetTableId,
          name: "Invalid formula",
          type: "formula",
          config: { expression: "UNKNOWN_FUNCTION(1)" },
        },
        null,
      );
      expect(invalidFormula.ok).toBe(false);
      if (!invalidFormula.ok) expect(invalidFormula.error.message).toContain("compile completely to SQL");
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("degrades on source-base deletion and repairs after restore", async () => {
    const fixture = await createFixture();
    try {
      const source = await buildDslSqlRecordSource(fixture.targetTableId, { [fixture.targetTableId]: fixture.targetFields });
      expect(source).not.toBeNull();

      const removed = await removeBase(fixture.sourceBaseId, null);
      expect(removed.ok).toBe(true);
      const degraded = await getCurrent(fixture.targetTableId);
      expect(degraded?.status).toBe("degraded");
      expect(degraded?.diagnostics.some((diagnostic) => diagnostic.code === "source_missing")).toBe(true);

      // A deleted source base filters every union branch down to zero rows, so
      // the in-relation guard is pruned away. The assertion carries it instead.
      let deletedSourceError: unknown = null;
      try {
        await assertFederatedPublication(source!);
        await sql`SELECT * FROM ${source!.relation} combined_record`;
      } catch (error) {
        deletedSourceError = error;
      }
      expect(deletedSourceError).toBeInstanceOf(Error);
      expect((deletedSourceError as Error).message).toContain("combined table publication changed");

      const restored = await restoreBase(fixture.sourceBaseId, null);
      expect(restored.ok).toBe(true);
      const repaired = await getCurrent(fixture.targetTableId);
      expect(repaired?.status).toBe("active");
      expect(repaired?.diagnostics).toEqual([]);

      const repairedSource = await buildDslSqlRecordSource(fixture.targetTableId, {
        [fixture.targetTableId]: fixture.targetFields,
      });
      expect(repairedSource).not.toBeNull();
      const rows = await sql<Array<{ id: string }>>`SELECT id::text FROM ${repairedSource!.relation} combined_record`;
      expect(rows.map((row) => row.id)).toEqual([fixture.recordId]);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("repairs a combined target after its own base is restored", async () => {
    const fixture = await createFixture();
    try {
      const removed = await removeBase(fixture.targetBaseId, null);
      expect(removed.ok).toBe(true);
      expect((await getCurrent(fixture.targetTableId))?.status).toBe("degraded");

      const restored = await restoreBase(fixture.targetBaseId, null);
      expect(restored.ok).toBe(true);
      const repaired = await getCurrent(fixture.targetTableId);
      expect(repaired?.status).toBe("active");
      expect(repaired?.diagnostics).toEqual([]);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("degrades combined relations when their combined target is deleted", async () => {
    const fixture = await createFixture();
    const relationSourceTableId = uuid();
    const relationSourceFieldId = uuid();
    const relationTargetTableId = uuid();
    const relationTargetFieldId = uuid();
    const relationRevisionId = uuid();
    try {
      await sql`
        INSERT INTO grids.tables (id, short_id, base_id, kind, name, position, disable_direct_insert)
        VALUES
          (${relationSourceTableId}::uuid, ${shortId("RS")}, ${fixture.sourceBaseId}::uuid, 'stored', 'Related source', 2, FALSE),
          (${relationTargetTableId}::uuid, ${shortId("RT")}, ${fixture.targetBaseId}::uuid, 'federated', 'Related combined', 2, TRUE)
      `;
      await sql`
        INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
        VALUES
          (${relationSourceFieldId}::uuid, ${shortId("RSF")}, ${relationSourceTableId}::uuid, 'Source relation', 'relation', ${{
            targetTableId: fixture.sourceTableId,
            cardinality: "multiple",
          }}::jsonb, 0),
          (${relationTargetFieldId}::uuid, ${shortId("RTF")}, ${relationTargetTableId}::uuid, 'Canonical relation', 'relation', ${{
            targetTableId: fixture.targetTableId,
            cardinality: "multiple",
          }}::jsonb, 0)
      `;
      await sql`
        INSERT INTO grids.federated_table_revisions (id, table_id, revision, status, published_at)
        VALUES (${relationRevisionId}::uuid, ${relationTargetTableId}::uuid, 1, 'active', now())
      `;
      await sql`
        INSERT INTO grids.federated_table_sources (revision_id, source_table_id, position, authorized_at)
        VALUES (${relationRevisionId}::uuid, ${relationSourceTableId}::uuid, 0, now())
      `;
      await sql`
        INSERT INTO grids.federated_field_mappings (revision_id, target_field_id, source_table_id, source_field_id, config)
        VALUES (
          ${relationRevisionId}::uuid,
          ${relationTargetFieldId}::uuid,
          ${relationSourceTableId}::uuid,
          ${relationSourceFieldId}::uuid,
          '{}'::jsonb
        )
      `;

      const removed = await removeTable(fixture.targetTableId, null);
      expect(removed.ok).toBe(true);
      expect((await getCurrent(relationTargetTableId))?.status).toBe("degraded");

      const restored = await restoreTable(fixture.targetTableId, null);
      expect(restored.ok).toBe(true);
      const repaired = await getCurrent(relationTargetTableId);
      expect(repaired?.status).toBe("active");
      expect(repaired?.diagnostics).toEqual([]);
    } finally {
      await sql`DELETE FROM grids.federated_table_revisions WHERE table_id = ${relationTargetTableId}::uuid`;
      await cleanupFixture(fixture);
    }
  });

  postgresTest("rejects semantically incompatible canonical mappings", async () => {
    const fixture = await createFixture();
    const sourcePercentId = uuid();
    const targetPercentId = uuid();
    const relationTargetId = uuid();
    const sourceRelationId = uuid();
    const targetRelationId = uuid();
    try {
      await sql`
        INSERT INTO grids.tables (id, short_id, base_id, kind, name, position)
        VALUES (${relationTargetId}::uuid, ${shortId("R")}, ${fixture.sourceBaseId}::uuid, 'stored', 'Relation target', 1)
      `;
      await sql`
        INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
        VALUES
          (${sourcePercentId}::uuid, ${shortId("SP")}, ${fixture.sourceTableId}::uuid, 'Source percent', 'percent', '{"range":"fraction"}'::jsonb, 2),
          (${targetPercentId}::uuid, ${shortId("TP")}, ${fixture.targetTableId}::uuid, 'Percent', 'percent', '{"range":"percent"}'::jsonb, 2),
          (${sourceRelationId}::uuid, ${shortId("SR")}, ${fixture.sourceTableId}::uuid, 'Source relation', 'relation', ${{
            targetTableId: relationTargetId,
            cardinality: "single",
          }}::jsonb, 3),
          (${targetRelationId}::uuid, ${shortId("TR")}, ${fixture.targetTableId}::uuid, 'Relation', 'relation', ${{
            targetTableId: relationTargetId,
            cardinality: "multiple",
          }}::jsonb, 3)
      `;
      await sql`UPDATE grids.fields SET required = TRUE WHERE id = ${targetPercentId}::uuid`;

      const validation = await validateDraft(fixture.targetTableId, {
        sourceTableIds: [fixture.sourceTableId],
        mappings: [
          {
            targetFieldId: targetPercentId,
            sourceTableId: fixture.sourceTableId,
            sourceFieldId: sourcePercentId,
          },
          {
            targetFieldId: targetRelationId,
            sourceTableId: fixture.sourceTableId,
            sourceFieldId: sourceRelationId,
          },
        ],
      });
      expect(validation.valid).toBe(false);
      expect(validation.diagnostics.map((diagnostic) => diagnostic.code)).toContain("percent_range_mismatch");
      expect(validation.diagnostics.map((diagnostic) => diagnostic.code)).toContain("relation_cardinality_mismatch");
      expect(validation.diagnostics.map((diagnostic) => diagnostic.code)).toContain("canonical_field_write_constraint");
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest(
    "plans and reads the supported fifty-source boundary",
    async () => {
      const fixture = await createFixture();
      const extra = Array.from({ length: 49 }, (_, index) => {
        const tableId = uuid();
        const fieldId = uuid();
        return {
          tableId,
          tableShortId: shortId("S"),
          tableName: `Boundary source ${index + 2}`,
          fieldId,
          fieldShortId: shortId("F"),
          fieldName: `Boundary field ${index + 2}`,
          recordId: uuid(),
          data: { [fieldId]: `Boundary value ${index + 2}` },
          position: index + 1,
        };
      });
      try {
        await sql`
        INSERT INTO grids.tables (id, short_id, base_id, kind, name, position, disable_direct_insert)
        SELECT id, short_id, ${fixture.sourceBaseId}::uuid, 'stored', name, position, FALSE
        FROM jsonb_to_recordset(${extra.map((item) => ({
          id: item.tableId,
          short_id: item.tableShortId,
          name: item.tableName,
          position: item.position,
        }))}::jsonb) AS item(id uuid, short_id text, name text, position int)
      `;
        await sql`
        INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position, presentable)
        SELECT id, short_id, table_id, name, 'text', '{}'::jsonb, 0, TRUE
        FROM jsonb_to_recordset(${extra.map((item) => ({
          id: item.fieldId,
          short_id: item.fieldShortId,
          table_id: item.tableId,
          name: item.fieldName,
        }))}::jsonb) AS item(id uuid, short_id text, table_id uuid, name text)
      `;
        await sql`
        INSERT INTO grids.records (id, short_id, table_id, data)
        SELECT id, short_id, table_id, data
        FROM jsonb_to_recordset(${extra.map((item) => ({
          id: item.recordId,
          short_id: shortId("R"),
          table_id: item.tableId,
          data: item.data,
        }))}::jsonb) AS item(id uuid, short_id text, table_id uuid, data jsonb)
      `;
        await sql`
        INSERT INTO grids.federated_table_sources (revision_id, source_table_id, position, authorized_at)
        SELECT ${fixture.revisionId}::uuid, source_table_id, position, now()
        FROM jsonb_to_recordset(${extra.map((item) => ({
          source_table_id: item.tableId,
          position: item.position,
        }))}::jsonb) AS item(source_table_id uuid, position int)
      `;
        await sql`
        INSERT INTO grids.federated_field_mappings (revision_id, target_field_id, source_table_id, source_field_id, config)
        SELECT ${fixture.revisionId}::uuid, ${fixture.targetTextFieldId}::uuid, source_table_id, source_field_id, '{}'::jsonb
        FROM jsonb_to_recordset(${extra.map((item) => ({
          source_table_id: item.tableId,
          source_field_id: item.fieldId,
        }))}::jsonb) AS item(source_table_id uuid, source_field_id uuid)
      `;

        const source = await buildDslSqlRecordSource(fixture.targetTableId, { [fixture.targetTableId]: fixture.targetFields });
        expect(source?.sourceTableIds).toHaveLength(50);
        const [count] = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count
        FROM ${source!.relation} combined_record
      `;
        expect(count?.count).toBe(50);
      } finally {
        await cleanupFixture(fixture);
      }
    },
    15_000,
  );

  postgresTest("isolates simultaneous combined exports with different filters, sorts and column projections", async () => {
    const fixture = await createFixture();
    const runQuery = boundedQuery.runBoundedQuery;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const keys: string[] = [];
    // Synchronize the actual SQL boundary so this tests coalescing, not scheduler luck.
    const timeout = setTimeout(release, 5_000);
    const run = spyOn(boundedQuery, "runBoundedQuery").mockImplementation(async <T>(...args: Parameters<typeof runQuery>): Promise<T[]> => {
      if (args[3]) {
        keys.push(args[3]);
        if (keys.length === 4) release();
        await barrier;
      }
      return runQuery<T>(...args);
    });
    try {
      await sql`UPDATE grids.records SET data = data || ${{ [fixture.sourceTextFieldId]: "Alpha" }}::jsonb WHERE id = ${fixture.recordId}::uuid`;
      for (const name of ["Bravo", "Charlie"]) {
        await sql`INSERT INTO grids.records (id, short_id, table_id, data)
          VALUES (${uuid()}::uuid, ${shortId("R")}, ${fixture.sourceTableId}::uuid, ${{ [fixture.sourceTextFieldId]: name }}::jsonb)`;
      }
      const fieldId = fixture.targetTextFieldId;
      const queries = [
        { sort: [{ fieldId, direction: "asc" as const }] },
        { sort: [{ fieldId, direction: "desc" as const }] },
        { filter: { fieldId, op: "contains", value: "Bravo" }, sort: [{ fieldId, direction: "asc" as const }] },
        {
          sort: [{ fieldId, direction: "asc" as const }],
          columns: [{ kind: "computed" as const, id: "computed_copy", label: "Copy", expression: "Name" }, { fieldId }],
        },
      ];
      const bodies = await Promise.all(
        queries.map(async (query) => {
          const exported = await exportRecords({ tableId: fixture.targetTableId, format: "json", fields: [{ fieldId }], query });
          if (!exported.ok) throw new Error(exported.error.message);
          return new Response(exported.data.body).json();
        }),
      );
      expect(bodies.map((body) => body.records.map((record: { Name: unknown }) => record.Name))).toEqual([
        ["Alpha", "Bravo", "Charlie"],
        ["Charlie", "Bravo", "Alpha"],
        ["Bravo"],
        ["Alpha", "Bravo", "Charlie"],
      ]);
      expect(new Set(keys).size).toBe(4);
    } finally {
      release();
      clearTimeout(timeout);
      run.mockRestore();
      await cleanupFixture(fixture);
    }
  });

  postgresTest("exports bound structured queries directly and rejects stale field references", async () => {
    const fixture = await createFixture();
    try {
      const value = 'Quarterly "hello"\nworld';
      await sql`UPDATE grids.records SET data = data || ${{ [fixture.sourceTextFieldId]: value }}::jsonb
        WHERE id = ${fixture.recordId}::uuid`;
      const result = await exportRecords({
        tableId: fixture.targetTableId,
        format: "json",
        fields: [{ fieldId: fixture.targetTextFieldId }],
        query: {
          filter: { fieldId: fixture.targetTextFieldId, op: "contains", value: '"hello"\nworld' },
          search: { q: "Quarterly", fieldIds: [fixture.targetTextFieldId] },
          sort: [{ fieldId: fixture.targetTextFieldId, direction: "desc" }],
          recordMeta: { ids: [fixture.recordId] },
          limit: 1,
        },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      const body = await new Response(result.data.body).json();
      expect(body.records).toHaveLength(1);
      expect(JSON.stringify(body.records)).toContain(JSON.stringify(value).slice(1, -1));

      const invalid = await exportRecords({
        tableId: fixture.targetTableId,
        format: "csv",
        fields: [{ fieldId: fixture.targetTextFieldId }],
        query: { search: { q: "anything", fieldIds: [uuid()] } },
      });
      expect(invalid.ok).toBe(false);
      if (!invalid.ok) expect(invalid.error.status).toBe(400);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest(
    "streams combined exports beyond ten thousand rows",
    async () => {
      const fixture = await createFixture();
      try {
        await sql`
        INSERT INTO grids.records (id, short_id, table_id, data)
        SELECT gen_random_uuid(), 'E' || lpad(sequence::text, 5, '0'), ${fixture.sourceTableId}::uuid,
               jsonb_build_object(${fixture.sourceTextFieldId}::text, 'Export row ' || sequence::text)
        FROM generate_series(1, 10025) sequence
      `;
        const exported = await exportRecords({
          tableId: fixture.targetTableId,
          format: "csv",
          fields: [{ fieldId: fixture.targetTextFieldId }],
        });
        expect(exported.ok).toBe(true);
        if (!exported.ok) return;
        const body = await new Response(exported.data.body).text();
        expect(body.trimEnd().split("\n")).toHaveLength(10027);

        const limited = await exportRecords({
          tableId: fixture.targetTableId,
          format: "csv",
          query: { limit: 7 },
          fields: [{ fieldId: fixture.targetTextFieldId }],
        });
        expect(limited.ok).toBe(true);
        if (!limited.ok) return;
        const limitedBody = await new Response(limited.data.body).text();
        expect(limitedBody.trimEnd().split("\n")).toHaveLength(8);
      } finally {
        await cleanupFixture(fixture);
      }
    },
    30_000,
  );
});
