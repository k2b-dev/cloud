import { beforeAll, expect } from "bun:test";
import { migrate } from "../migrate";
import { cleanupFixture, insertDslDbFixture, postgresTest } from "../query-dsl/sql-compiler.integration-fixtures";
import { gridsService } from "../service";
import { projectDocumentPreviewData } from "./documents-api-shared";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

postgresTest("live document preview projects real GQL relations and does not resolve its public record ID as a UUID", async () => {
  const fixture = await insertDslDbFixture();
  try {
    const table = await gridsService.table.get(fixture.orders.id);
    const record = await gridsService.record.get(fixture.orders.id, fixture.orderAId, {
      viewer: { userId: null, userGroups: [], isAdmin: true },
    });
    expect(table).not.toBeNull();
    expect(record).not.toBeNull();
    const rendered = await gridsService.document.buildLiveRenderData({
      table: table!,
      record: record!,
      template: { source: `from table ${fixture.orders.shortId}\nselect AMT01x, CUSTLx\nlimit 1` },
    });
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) throw new Error(rendered.error.message);
    expect(rendered.data.data.record).toMatchObject({ id: record!.shortId });
    const projected = await projectDocumentPreviewData(rendered.data.data, { tableId: table!.id, recordId: record!.id });
    expect(projected.record.id).toBe(record!.shortId);
    expect(projected.table.id).toBe(table!.shortId);
    expect(projected.columns.map((column) => column.fieldId)).toEqual(["AMT01x", "CUSTLx"]);
    expect(projected.rows).toEqual([expect.objectContaining({ Customer: ["Alice"] })]);
    expect(projected.record.data.CUSTLx).toEqual([expect.stringMatching(/^[A-Za-z0-9]{6}$/)]);
    for (const id of [
      fixture.baseId,
      table!.id,
      record!.id,
      fixture.customerLinkId,
      fixture.amountId,
      fixture.customerAId,
      fixture.customerBId,
    ])
      expect(JSON.stringify(projected)).not.toContain(id);

    const aggregate = await gridsService.document.buildLiveRenderData({
      table: table!,
      record: record!,
      template: { source: `from table ${fixture.orders.shortId}\naggregate sum(AMT01x) as total` },
    });
    expect(aggregate.ok).toBe(true);
    if (!aggregate.ok) throw new Error(aggregate.error.message);
    const aggregatePreview = await projectDocumentPreviewData(aggregate.data.data, { tableId: table!.id, recordId: record!.id });
    expect(aggregatePreview.columns[0]?.key).toBe("AMT01x__sum");
    expect(aggregatePreview.rows[0]?.AMT01x__sum).toBeDefined();
    expect(JSON.stringify(aggregatePreview)).not.toContain(fixture.amountId);
  } finally {
    await cleanupFixture(fixture.baseId);
  }
});
