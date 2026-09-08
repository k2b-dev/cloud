import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { mapFieldRow } from "./field-read";
import type { GridsWorkflowActionScope } from "./workflow-action-scope";
import { atomicQueryMatches, resolveWorkflowRecordValues } from "./workflow-atomic-records";

const baseId = "11111111-1111-4111-8111-111111111111";
const tableId = "22222222-2222-4222-8222-222222222222";
const targetTableId = "33333333-3333-4333-8333-333333333333";
const fieldId = "44444444-4444-4444-8444-444444444444";
const recordId = "55555555-5555-4555-8555-555555555555";
const scope: GridsWorkflowActionScope = {
  runId: baseId,
  baseId,
  workflow: { id: baseId, shortId: "WORK01", name: "Test" },
  principal: { userId: baseId, groupIds: [], serviceAccountId: null, actorServiceAccountId: null, credential: null },
  authorization: { kind: "workflow" },
  launcherId: null,
};
const fieldRow = {
  id: fieldId,
  short_id: "FIELD1",
  table_id: tableId,
  name: "Item",
  type: "relation",
  config: { targetTableId, cardinality: "single" },
  created_at: new Date(),
  updated_at: new Date(),
};
const fields = [mapFieldRow(fieldRow)];

const fixture = (options: { permitted?: boolean; sameBase?: boolean; correctTarget?: boolean } = {}) => {
  const calls: string[] = [];
  const queries: unknown[][] = [];
  const db = Object.assign(
    async (strings: TemplateStringsArray, ...parameters: unknown[]) => {
      const query = strings.join("?");
      calls.push(query);
      queries.push(parameters);
      if (query.includes("SELECT f.*")) return [fieldRow];
      if (query.includes("SELECT now()")) return [{ now: new Date() }];
      if (query.includes("FROM auth.users")) return [{ id: baseId, account_expires: null }];
      if (query.includes("FROM grids.base_access"))
        return options.permitted === false ? [] : [{ resource_type: "base", resource_id: baseId, principal_tier: "user", level: "write" }];
      if (query.includes("FROM grids.tables")) return options.sameBase === false ? [] : [{ id: targetTableId, found: true }];
      if (query.includes("SELECT EXISTS")) return [{ matches: true }];
      if (query.includes("FROM grids.records r")) return options.correctTarget === false ? [] : [{ id: recordId }];
      throw new Error(`Unexpected query: ${query}`);
    },
    {
      unsafe: async (query: string) => {
        calls.push(query);
        queries.push([]);
        return [{ publicId: "REC001", internalId: recordId }];
      },
      array: (ids: string[]) => ids,
    },
  ) as unknown as SQL;
  return { db, calls, queries };
};

describe("workflow relation values", () => {
  test("resolves public IDs after permission checks and verifies the exact relation target", async () => {
    const { db, calls, queries } = fixture();
    expect(await resolveWorkflowRecordValues(scope, fields, { [fieldId]: "REC001" }, db)).toEqual({ [fieldId]: recordId });
    expect(calls.findIndex((query) => query.includes("FROM grids.base_access"))).toBeLessThan(
      calls.findIndex((query) => query.includes("short_id AS")),
    );
    const targetRead = calls.findIndex((query) => query.includes("FROM grids.records r"));
    expect(queries[targetRead]).toContain(targetTableId);
    expect(calls[targetRead]).toContain("r.table_id =");
    const wrong = fixture({ correctTarget: false });
    await expect(resolveWorkflowRecordValues(scope, fields, { [fieldId]: "REC001" }, wrong.db)).rejects.toMatchObject({
      code: "WORKFLOW_VALUE_INVALID",
    });
  });

  test("denied and foreign-base targets do not resolve or inspect record IDs", async () => {
    for (const options of [{ permitted: false }, { sameBase: false }]) {
      const { db, calls } = fixture(options);
      await expect(resolveWorkflowRecordValues(scope, fields, { [fieldId]: "REC001" }, db)).rejects.toBeInstanceOf(Error);
      expect(calls.some((query) => query.includes("FROM grids.records"))).toBe(false);
    }
  });

  test("atomic relation checks consume the same public-ID contract", async () => {
    const { db, calls } = fixture();
    expect(
      await atomicQueryMatches({
        scope,
        client: db,
        tableId,
        timeZone: "UTC",
        predicates: [{ fieldId, op: "containsAny", value: ["REC001"] }],
      }),
    ).toBe(true);
    expect(calls.some((query) => query.includes("SELECT EXISTS"))).toBe(true);
    const denied = fixture({ permitted: false });
    await expect(
      atomicQueryMatches({
        scope,
        client: denied.db,
        tableId,
        timeZone: "UTC",
        predicates: [{ fieldId, op: "containsAny", value: ["REC001"] }],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(denied.calls.some((query) => query.includes("SELECT EXISTS"))).toBe(false);
  });
});
