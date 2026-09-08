import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { listReferencedBy } from "./referenced-by";

const cursorSigningKey = "referenced-by-integration-test-key";

type Fixture = {
  baseId: string;
  targetTableId: string;
  targetRecordId: string;
  sourceTableId: string;
  otherSourceTableId: string;
  relationFieldId: string;
  relationFieldShortId: string;
  otherRelationFieldId: string;
  otherRelationFieldShortId: string;
  sourceRecordIds: string[];
  otherSourceRecordId: string;
};

const createFixture = async (sourceCount = 550): Promise<Fixture> => {
  const baseId = testUuid();
  const targetTableId = testUuid();
  const targetRecordId = testUuid();
  const sourceTableId = testUuid();
  const otherSourceTableId = testUuid();
  const labelFieldId = testUuid();
  const relationFieldId = testUuid();
  const relationFieldShortId = testShortId("F");
  const otherRelationFieldId = testUuid();
  const otherRelationFieldShortId = testShortId("G");
  const sourceRecordIds = Array.from({ length: sourceCount }, () => testUuid());
  const otherSourceRecordId = testUuid();

  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'Referenced by')`;
  await sql`
    INSERT INTO grids.tables (id, short_id, base_id, name, kind, position) VALUES
      (${targetTableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Targets', 'stored', 0),
      (${sourceTableId}::uuid, ${testShortId("S")}, ${baseId}::uuid, 'Sources', 'stored', 1),
      (${otherSourceTableId}::uuid, ${testShortId("O")}, ${baseId}::uuid, 'Other sources', 'stored', 2)
  `;
  await sql`
    INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position, presentable) VALUES
      (${labelFieldId}::uuid, ${testShortId("L")}, ${sourceTableId}::uuid, 'Name', 'text', '{}'::jsonb, 0, TRUE),
      (
        ${relationFieldId}::uuid,
        ${relationFieldShortId},
        ${sourceTableId}::uuid,
        'Target',
        'relation',
        ${{ targetTableId }}::jsonb,
        1,
        FALSE
      ),
      (
        ${otherRelationFieldId}::uuid,
        ${otherRelationFieldShortId},
        ${otherSourceTableId}::uuid,
        'Other target',
        'relation',
        ${{ targetTableId }}::jsonb,
        0,
        FALSE
      )
  `;
  await sql`
    INSERT INTO grids.records (id, short_id, table_id, data)
    VALUES (${targetRecordId}::uuid, ${testShortId("R")}, ${targetTableId}::uuid, '{}'::jsonb)
  `;

  for (let offset = 0; offset < sourceRecordIds.length; offset += 50) {
    const chunk = sourceRecordIds.slice(offset, offset + 50);
    const values = chunk
      .map(
        (id, index) =>
          sql`(${id}::uuid, ${testShortId("R")}, ${sourceTableId}::uuid, ${{ [labelFieldId]: `Source ${offset + index}` }}::jsonb)`,
      )
      .reduce((left, right) => sql`${left}, ${right}`);
    await sql`INSERT INTO grids.records (id, short_id, table_id, data) VALUES ${values}`;
    const links = chunk
      .map((id) => sql`(${id}::uuid, ${relationFieldId}::uuid, ${targetRecordId}::uuid, 0)`)
      .reduce((left, right) => sql`${left}, ${right}`);
    await sql`INSERT INTO grids.record_links (from_record_id, from_field_id, to_record_id, position) VALUES ${links}`;
  }
  await sql`
    INSERT INTO grids.records (id, short_id, table_id, data)
    VALUES (${otherSourceRecordId}::uuid, ${testShortId("R")}, ${otherSourceTableId}::uuid, '{}'::jsonb)
  `;
  await sql`
    INSERT INTO grids.record_links (from_record_id, from_field_id, to_record_id, position)
    VALUES (${otherSourceRecordId}::uuid, ${otherRelationFieldId}::uuid, ${targetRecordId}::uuid, 0)
  `;

  return {
    baseId,
    targetTableId,
    targetRecordId,
    sourceTableId,
    otherSourceTableId,
    relationFieldId,
    relationFieldShortId,
    otherRelationFieldId,
    otherRelationFieldShortId,
    sourceRecordIds,
    otherSourceRecordId,
  };
};

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("referenced-by integration", () => {
  postgresTest("paginates live stored links with public-boundary cursors and batched safe labels", async () => {
    const fixture = await createFixture();
    try {
      const defaultPage = await listReferencedBy({
        targetTableId: fixture.targetTableId,
        targetRecordId: fixture.targetRecordId,
        cursorSigningKey,
      });
      expect(defaultPage.ok).toBe(true);
      if (!defaultPage.ok) throw new Error(defaultPage.error.message);
      expect(defaultPage.data.items).toHaveLength(25);

      const cappedPage = await listReferencedBy({
        targetTableId: fixture.targetTableId,
        targetRecordId: fixture.targetRecordId,
        limit: 1_000,
        cursorSigningKey,
      });
      expect(cappedPage.ok).toBe(true);
      if (!cappedPage.ok) throw new Error(cappedPage.error.message);
      expect(cappedPage.data.items).toHaveLength(100);

      const items: Array<{ sourceRecordId: string; sourceRecordLabel: string }> = [];
      let cursor: string | null = null;
      do {
        const page = await listReferencedBy({
          targetTableId: fixture.targetTableId,
          targetRecordId: fixture.targetRecordId,
          cursor,
          limit: 25,
          cursorSigningKey,
        });
        expect(page.ok).toBe(true);
        if (!page.ok) throw new Error(page.error.message);
        items.push(...page.data.items);
        cursor = page.data.nextCursor;
      } while (cursor);

      expect(items).toHaveLength(551);
      expect(new Set(items.map((item) => item.sourceRecordId)).size).toBe(551);
      expect(items.some((item) => item.sourceRecordLabel === "Source 0")).toBe(true);
      expect(items.some((item) => item.sourceRecordLabel === "Untitled record")).toBe(true);
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
    }
  });

  postgresTest("filters by relation public ID and fails closed for deleted or mismatched resources", async () => {
    const fixture = await createFixture(6);
    try {
      const filtered = await listReferencedBy({
        targetTableId: fixture.targetTableId,
        targetRecordId: fixture.targetRecordId,
        relationFieldId: fixture.otherRelationFieldShortId,
        cursorSigningKey,
      });
      expect(filtered.ok).toBe(true);
      if (!filtered.ok) throw new Error(filtered.error.message);
      expect(filtered.data.items.map((item) => item.sourceRecordId)).toEqual([fixture.otherSourceRecordId]);

      const unknownFilter = await listReferencedBy({
        targetTableId: fixture.targetTableId,
        targetRecordId: fixture.targetRecordId,
        relationFieldId: "none00",
        cursorSigningKey,
      });
      expect(unknownFilter).toEqual({ ok: true, data: { items: [], nextCursor: null } });

      await sql`UPDATE grids.records SET deleted_at = now() WHERE id = ${fixture.sourceRecordIds[0]}::uuid`;
      await sql`UPDATE grids.fields SET deleted_at = now() WHERE id = ${fixture.otherRelationFieldId}::uuid`;
      const live = await listReferencedBy({
        targetTableId: fixture.targetTableId,
        targetRecordId: fixture.targetRecordId,
        cursorSigningKey,
      });
      expect(live.ok).toBe(true);
      if (!live.ok) throw new Error(live.error.message);
      expect(live.data.items.map((item) => item.sourceRecordId)).not.toContain(fixture.sourceRecordIds[0]);
      expect(live.data.items.map((item) => item.sourceRecordId)).not.toContain(fixture.otherSourceRecordId);

      await sql`UPDATE grids.records SET deleted_at = now() WHERE id = ${fixture.targetRecordId}::uuid`;
      const hiddenTarget = await listReferencedBy({
        targetTableId: fixture.targetTableId,
        targetRecordId: fixture.targetRecordId,
        cursorSigningKey,
      });
      expect(hiddenTarget.ok).toBe(false);
      if (hiddenTarget.ok) throw new Error("Expected deleted target to be hidden");
      expect(hiddenTarget.error.status).toBe(404);
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
    }
  });

  postgresTest("keeps keyset pages stable across inserts and deletes after the current boundary", async () => {
    const fixture = await createFixture(40);
    try {
      const first = await listReferencedBy({
        targetTableId: fixture.targetTableId,
        targetRecordId: fixture.targetRecordId,
        limit: 10,
        cursorSigningKey,
      });
      expect(first.ok).toBe(true);
      if (!first.ok || !first.data.nextCursor) throw new Error("Expected a full first page");
      const boundary = first.data.items.at(-1)!;
      const [inserted] = await sql<Array<{ id: string }>>`
        SELECT candidate.id::text
        FROM (SELECT gen_random_uuid() AS id FROM generate_series(1, 64)) candidate
        WHERE candidate.id > ${boundary.sourceRecordId}::uuid
        ORDER BY candidate.id
        LIMIT 1
      `;
      if (!inserted) throw new Error("Could not create a record ID after the page boundary");
      const [deleted] = await sql<Array<{ id: string }>>`
        SELECT id::text
        FROM grids.records
        WHERE id = ANY(${sql.array(fixture.sourceRecordIds, "UUID")}::uuid[])
          AND id > ${boundary.sourceRecordId}::uuid
        ORDER BY id DESC
        LIMIT 1
      `;
      if (!deleted) throw new Error("Expected an existing record after the page boundary");
      await sql`
        INSERT INTO grids.records (id, short_id, table_id, data)
        VALUES (${inserted.id}::uuid, ${testShortId("R")}, ${fixture.sourceTableId}::uuid, '{}'::jsonb)
      `;
      await sql`
        INSERT INTO grids.record_links (from_record_id, from_field_id, to_record_id, position)
        VALUES (${inserted.id}::uuid, ${fixture.relationFieldId}::uuid, ${fixture.targetRecordId}::uuid, 0)
      `;
      await sql`UPDATE grids.records SET deleted_at = now() WHERE id = ${deleted.id}::uuid`;

      const laterIds: string[] = [];
      let cursor: string | null = first.data.nextCursor;
      while (cursor) {
        const page = await listReferencedBy({
          targetTableId: fixture.targetTableId,
          targetRecordId: fixture.targetRecordId,
          cursor,
          limit: 10,
          cursorSigningKey,
        });
        expect(page.ok).toBe(true);
        if (!page.ok) throw new Error(page.error.message);
        laterIds.push(...page.data.items.map((item) => item.sourceRecordId));
        cursor = page.data.nextCursor;
      }
      expect(laterIds).toContain(inserted.id);
      expect(laterIds).not.toContain(deleted.id);
      const allIds = [...first.data.items.map((item) => item.sourceRecordId), ...laterIds];
      expect(new Set(allIds).size).toBe(allIds.length);
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
    }
  });

  postgresTest("uses the covering reverse-page index without a sort", async () => {
    const fixture = await createFixture(130);
    try {
      const unrelatedTargets = Array.from({ length: 24 }, () => testUuid());
      const targetValues = unrelatedTargets
        .map((id) => sql`(${id}::uuid, ${testShortId("R")}, ${fixture.targetTableId}::uuid, '{}'::jsonb)`)
        .reduce((left, right) => sql`${left}, ${right}`);
      await sql`INSERT INTO grids.records (id, short_id, table_id, data) VALUES ${targetValues}`;
      for (const targetId of unrelatedTargets) {
        await sql`
          INSERT INTO grids.record_links (from_record_id, from_field_id, to_record_id, position)
          SELECT record.id, ${fixture.relationFieldId}::uuid, ${targetId}::uuid, 0
          FROM grids.records record
          WHERE record.table_id = ${fixture.sourceTableId}::uuid
            AND record.deleted_at IS NULL
        `;
      }
      await sql`ANALYZE grids.record_links`;
      const [explained] = await sql<Array<Record<string, unknown>>>`
        EXPLAIN (ANALYZE, FORMAT JSON)
        SELECT link.from_field_id, link.from_record_id
        FROM grids.record_links link
        WHERE link.to_record_id = ${fixture.targetRecordId}::uuid
        ORDER BY link.from_field_id, link.from_record_id
        LIMIT 25
      `;
      const plan = JSON.stringify(explained ? Object.values(explained)[0] : null);
      expect(plan).toContain("idx_grids_record_links_reverse_page");
      expect(plan).not.toContain('"Node Type":"Sort"');
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
    }
  });
});
