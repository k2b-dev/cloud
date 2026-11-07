import { beforeAll, describe, expect, spyOn } from "bun:test";
import { sql } from "@k2b/cloud";
import { err, fail, ok } from "@k2b/stdlib";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { postgresTest, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { prepareCustomAppDocumentPreview } from "./custom-app-document-preview";
import { resultTransaction, transactionWithRollback } from "./transaction-rollback";
import type { GridsWorkflowActionScope } from "./workflow-action-scope";
import { canExecuteRunBeforeHttp } from "./workflow-action-scope";
import * as authorization from "./workflow-execution-authorization";

describe("transactions that end with a value after a failed statement", () => {
  beforeAll(async () => {
    if (testInfra.database) await migrate();
  });

  postgresTest("rollback returns the value instead of a rejected COMMIT", async () => {
    const value = await transactionWithRollback<string>(async (client, rollback) => {
      await client`SELECT 1/0`.catch(() => undefined);
      return rollback("denied");
    });
    expect(value).toBe("denied");
  });

  postgresTest("rollback discards earlier writes and a thrown error stays an error", async () => {
    const name = `transaction_rollback_${crypto.randomUUID().replaceAll("-", "")}`;
    await transactionWithRollback<null>(async (client, rollback) => {
      await client.unsafe(`CREATE TABLE ${name} (id int)`);
      return rollback(null);
    });
    const [table] = await sql<{ found: string | null }[]>`SELECT to_regclass(${name})::text AS found`;
    expect(table?.found).toBeNull();
    await expect(
      transactionWithRollback(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  postgresTest("a failed Result rolls back, a successful one commits", async () => {
    expect(await resultTransaction(async () => ok(1))).toEqual(ok(1));
    const failed = fail(err.badInput("Failed"));
    expect(
      await resultTransaction(async (client) => {
        await client`SELECT 1/0`.catch(() => undefined);
        return failed;
      }),
    ).toEqual(failed);
  });

  const withScratchTable = async (work: (name: string) => Promise<void>) => {
    const name = `transaction_rollback_${crypto.randomUUID().replaceAll("-", "")}`;
    await sql.unsafe(`CREATE TABLE ${name} (value text)`);
    try {
      await work(name);
    } finally {
      await sql.unsafe(`DROP TABLE ${name}`);
    }
  };
  const valuesIn = async (name: string) =>
    (await sql.unsafe<{ value: string }[]>(`SELECT value FROM ${name} ORDER BY value`)).map(({ value }) => value);

  postgresTest("a transaction that does not roll back keeps its write", async () => {
    await withScratchTable(async (name) => {
      const value = await transactionWithRollback<string>(async (client) => {
        await client.unsafe(`INSERT INTO ${name} VALUES ('kept')`);
        return "committed";
      });
      expect(value).toBe("committed");
      expect(await valuesIn(name)).toEqual(["kept"]);
    });
  });

  postgresTest("a failed inner savepoint leaves the outer transaction usable", async () => {
    await withScratchTable(async (name) => {
      const value = await transactionWithRollback<string>(
        async (client) => {
          await client.unsafe(`INSERT INTO ${name} VALUES ('after')`);
          return "committed";
        },
        (run) =>
          sql.begin(async (tx) => {
            await tx.unsafe(`INSERT INTO ${name} VALUES ('before')`);
            await tx
              .savepoint(async (inner) => {
                await inner.unsafe(`INSERT INTO ${name} VALUES ('inner')`);
                await inner`SELECT 1/0`;
              })
              .catch(() => undefined);
            return run(tx);
          }),
      );
      expect(value).toBe("committed");
      expect(await valuesIn(name)).toEqual(["after", "before"]);
    });
  });

  postgresTest("parallel calls each keep their own outcome", async () => {
    await withScratchTable(async (name) => {
      const outcomes = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          transactionWithRollback<string>(async (client, rollback) => {
            await client.unsafe(`INSERT INTO ${name} VALUES ('call-${index}')`);
            if (index % 2 === 0) return `committed-${index}`;
            await client`SELECT 1/0`.catch(() => undefined);
            return rollback(`rolled-back-${index}`);
          }),
        ),
      );
      expect(outcomes).toEqual(["committed-0", "rolled-back-1", "committed-2", "rolled-back-3", "committed-4", "rolled-back-5"]);
      expect(await valuesIn(name)).toEqual(["call-0", "call-2", "call-4"]);
    });
  });

  postgresTest("a document preview denied after a caught SQL error is unavailable", async () => {
    const preview = await prepareCustomAppDocumentPreview({
      baseId: testUuid(),
      tableId: testUuid(),
      templateId: testUuid(),
      fingerprint: "unused",
      recordId: testUuid(),
      recordVersion: 1,
      dateConfig: { locale: "en", timeZone: "UTC" },
      signal: new AbortController().signal,
      authorize: async (client) => {
        await client`SELECT 1/0`.catch(() => undefined);
        return false;
      },
    });
    expect(preview).toBeNull();
  });

  postgresTest("a workflow denied after a caught SQL error stays denied before its HTTP action", async () => {
    const decision = spyOn(authorization, "canExecuteWorkflow").mockImplementation(async (_scope, client) => {
      if (client) await client`SELECT 1/0`.catch(() => undefined);
      return false;
    });
    try {
      const scope = { workflow: { id: testUuid() } } as unknown as GridsWorkflowActionScope;
      expect(await canExecuteRunBeforeHttp(scope, new AbortController().signal)).toBe(false);
    } finally {
      decision.mockRestore();
    }
  });
});
