import { beforeAll, expect } from "bun:test";
import { sql } from "bun";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { jsonDocumentProfile } from "../document-profiles/table";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { createDocumentIssuanceService, type IssueDocumentInput } from "./document-issuance";
import { createTemplate } from "./document-templates";
import { enable as enableHistory } from "./durable-history";
import { enable as enableFinalization, finalize } from "./record-finalization";

beforeAll(async () => {
  if (!testInfra.database) return;
  const [db] = await sql<Array<{ name: string }>>`SELECT current_database() AS name`;
  if (!db?.name.startsWith("grids_verify_")) throw new Error("Document reservation locks require an isolated grids_verify_ database");
  await migrate();
}, 30_000);

const fixture = async (): Promise<IssueDocumentInput> => {
  const baseId = testUuid();
  const tableId = testUuid();
  const recordId = testUuid();
  const recordShortId = testShortId("R");
  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'Reservation locks')`;
  await sql`INSERT INTO grids.tables (id, short_id, base_id, name)
    VALUES (${tableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Invoices')`;
  await sql`INSERT INTO grids.records (id, short_id, table_id, data)
    VALUES (${recordId}::uuid, ${recordShortId}, ${tableId}::uuid, '{}'::jsonb)`;
  for (const enabled of [await enableHistory(tableId, null), await enableFinalization(tableId, { mode: "direct" }, null)]) {
    if (!enabled.ok) throw enabled.error;
  }
  const finalized = await finalize({ tableId, recordId, actorId: null, origin: "direct" });
  if (!finalized.ok) throw finalized.error;
  const template = await createTemplate(
    tableId,
    {
      name: "Reservation",
      source: "from table Invoices",
      issuancePolicy: "oncePerFinalizedRecord",
      renderer: {
        kind: "profile",
        id: jsonDocumentProfile.id,
        version: jsonDocumentProfile.version,
        inputTemplate: '{"columns":[{"key":"name","label":"Name","type":"text","sqlType":"text"}],"rows":[]}',
      },
    },
    null,
  );
  if (!template.ok) throw template.error;
  const root = {
    id: recordId,
    table: { id: tableId },
    fields: [],
    data: {},
    version: finalized.data.version,
    createdAt: finalized.data.createdAt,
    updatedAt: finalized.data.updatedAt,
    deletedAt: null,
  };
  return {
    template: template.data,
    snapshot: {
      id: testUuid(),
      baseId,
      tableId,
      recordId,
      root,
      graph: { rootId: `${tableId}:${recordId}`, records: { [`${tableId}:${recordId}`]: root } },
      createdBy: null,
      createdAt: finalized.data.updatedAt,
    },
    renderData: { record: { id: recordShortId, version: root.version, updatedAt: root.updatedAt, data: {} } },
    actor: { kind: "system" },
    idempotencyKey: testUuid(),
    canReadTable: async () => true,
  };
};

for (const lockedTarget of ["record", "table", "base"] as const) {
  postgresTest(
    `document reservation waits for ${lockedTarget} writers before taking its issuance mutex`,
    async () => {
      const input = await fixture();
      const service = createDocumentIssuanceService();
      const started = Promise.withResolvers<number>();
      let concurrent: Promise<string> | undefined;
      try {
        const receiptId = await sql.begin(async (writer) => {
          await writer`SET LOCAL lock_timeout = '10s'`;
          await writer`SET LOCAL statement_timeout = '15s'`;
          const [owner] = await writer<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
          if (!owner) throw new Error("Missing writer connection");
          if (lockedTarget === "base") {
            await writer`SELECT id FROM grids.bases WHERE id = ${input.snapshot.baseId}::uuid FOR UPDATE`;
          } else {
            await writer`SELECT id FROM grids.bases WHERE id = ${input.snapshot.baseId}::uuid FOR SHARE`;
            if (lockedTarget === "table") {
              await writer`SELECT id FROM grids.tables WHERE id = ${input.snapshot.tableId}::uuid FOR UPDATE`;
            } else {
              await writer`SELECT id FROM grids.tables WHERE id = ${input.snapshot.tableId}::uuid FOR SHARE`;
              await writer`SELECT id FROM grids.records WHERE id = ${input.snapshot.recordId}::uuid FOR UPDATE`;
            }
          }
          concurrent = sql.begin(async (issuer) => {
            await issuer`SET LOCAL lock_timeout = '10s'`;
            await issuer`SET LOCAL statement_timeout = '15s'`;
            const [connection] = await issuer<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            if (!connection) throw new Error("Missing issuer connection");
            started.resolve(connection.pid);
            const reserved = await service.reserveDocumentInTransaction(issuer, { ...input, idempotencyKey: testUuid() });
            if (!reserved.ok) throw reserved.error;
            return reserved.data.id;
          });
          // Drain rejection even if the lock-observation assertion fails first.
          concurrent.catch((error) => started.reject(error));
          const issuerPid = await started.promise;
          const deadline = Date.now() + 5_000;
          while (true) {
            const [waiting] = await sql<Array<{ blocked: boolean }>>`
              SELECT ${owner.pid} = ANY(pg_blocking_pids(${issuerPid})) AS blocked`;
            if (waiting?.blocked) break;
            if (Date.now() >= deadline) throw new Error("Issuer did not wait for the writer lock");
            await Bun.sleep(20);
          }
          // The issuer must not own the advisory lock while it waits for this
          // transaction. Both reservations then converge after writer commit.
          const reserved = await service.reserveDocumentInTransaction(writer, input);
          if (!reserved.ok) throw reserved.error;
          return reserved.data.id;
        });
        expect(await concurrent).toBe(receiptId);
        expect(await sql`SELECT id FROM grids.document_issuances WHERE base_id = ${input.snapshot.baseId}::uuid`).toHaveLength(1);
        const [counter] = await sql`SELECT next_value FROM grids.document_profile_counters WHERE base_id = ${input.snapshot.baseId}::uuid`;
        expect(Number(counter?.next_value)).toBe(2);
        expect(await sql`SELECT id FROM grids.documents WHERE base_id = ${input.snapshot.baseId}::uuid`).toHaveLength(0);
      } finally {
        await concurrent?.catch(() => undefined);
      }
    },
    30_000,
  );
}
