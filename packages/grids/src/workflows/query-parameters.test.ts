import { expect, test } from "bun:test";
import {
  resolveWorkflowQueryParameters,
  type WorkflowQueryParameters,
  WorkflowQueryParametersSchema,
  workflowQueryParameterSamples,
} from "./query-parameters";

test("workflow parameters enforce shared name and resolved JSON budgets", async () => {
  const excessiveNames = Object.fromEntries(
    Array.from({ length: 101 }, (_, index) => [`p${index}`, { type: "text" as const, value: "x" }]),
  );
  expect(WorkflowQueryParametersSchema.safeParse(excessiveNames).success).toBe(false);
  expect(
    (
      await resolveWorkflowQueryParameters(excessiveNames, async () => {
        throw new Error("must not resolve records");
      })
    ).ok,
  ).toBe(false);
  const excessiveValues: WorkflowQueryParameters[] = [
    { value: { type: "text" as const, value: "x".repeat(20_001) } },
    { value: { type: "text" as const, value: "x".repeat(11_000) }, other: { type: "text" as const, value: "y".repeat(11_000) } },
  ];
  for (const parameters of excessiveValues) expect((await resolveWorkflowQueryParameters(parameters, async () => [])).ok).toBe(false);
  expect((await resolveWorkflowQueryParameters({ value: { type: "text", value: "x".repeat(19_000) } }, async () => [])).ok).toBe(true);
});

test("query parameter values retain their declared scalar types and exact decimals", async () => {
  const parameters = WorkflowQueryParametersSchema.parse({
    amount: { type: "decimal", value: "9007199254740993.01" },
    enabled: { type: "boolean", value: false },
    name: { type: "text", value: "' OR true --" },
    count: { type: "number", value: 3 },
    date: { type: "date", value: "2026-09-11" },
  });
  expect(
    await resolveWorkflowQueryParameters(parameters, async () => {
      throw new Error("not a record");
    }),
  ).toEqual({
    ok: true,
    values: {
      "params.amount": { decimal: "9007199254740993.01" },
      "params.enabled": false,
      "params.name": "' OR true --",
      "params.count": 3,
      "params.date": "2026-09-11",
    },
  });
  expect(workflowQueryParameterSamples(parameters)["params.amount"]).toEqual({ decimal: "0" });
});

test("record parameter budgets precede lookups and duplicate identities resolve once", async () => {
  const reference = { kind: "record", tableId: "00000000-0000-4000-8000-000000000001", recordId: "00000000-0000-4000-8000-000000000002" };
  let calls = 0;
  const resolve = async () => {
    calls++;
    return ["REC001"];
  };
  const oversized = await resolveWorkflowQueryParameters(
    { selected: { type: "recordList", value: Array.from({ length: 3000 }, () => reference) } },
    resolve,
  );
  expect(oversized.ok).toBe(false);
  expect(calls).toBe(0);
  const repeated = await resolveWorkflowQueryParameters({ selected: { type: "recordList", value: [reference, reference] } }, resolve);
  expect(repeated).toEqual({ ok: true, values: { "params.selected": ["REC001", "REC001"] } });
  expect(calls).toBe(1);
});

test("record parameters resolve as one deduplicated batch and restore each parameter's order", async () => {
  const first = { kind: "record" as const, tableId: Bun.randomUUIDv7(), recordId: Bun.randomUUIDv7() };
  const second = { ...first, tableId: Bun.randomUUIDv7() };
  const parameters: WorkflowQueryParameters = {
    selected: { type: "recordList", value: [first, second, first] },
    other: { type: "record", value: second },
  };
  let calls = 0;
  const result = await resolveWorkflowQueryParameters(parameters, async (references) => {
    calls++;
    expect(references).toEqual([first, second]);
    return ["REC001", "REC002"];
  });
  expect(calls).toBe(1);
  expect(result).toEqual({ ok: true, values: { "params.selected": ["REC001", "REC002", "REC001"], "params.other": "REC002" } });
  for (const invalid of [["REC001"], ["REC001", "not-a-public-id"], ["REC001", "REC002", "REC003"]]) {
    expect(await resolveWorkflowQueryParameters(parameters, async () => invalid)).toEqual({ ok: false, parameter: "selected" });
  }
});

test("query parameter validation rejects coercion, lossy integers and invalid dates without leaking values", async () => {
  for (const [type, value] of [
    ["decimal", 1.2],
    ["decimal", "1e3"],
    ["number", "12"],
    ["number", 9007199254740992],
    ["boolean", "false"],
    ["date", "2026-02-30"],
    ["text", null],
  ] as const) {
    const parameters = WorkflowQueryParametersSchema.parse({ invalid: { type, value } });
    expect(await resolveWorkflowQueryParameters(parameters, async () => [])).toEqual({ ok: false, parameter: "invalid" });
  }
  expect(WorkflowQueryParametersSchema.safeParse({ "auth.id": { type: "text", value: "impersonate" } }).success).toBe(false);
});

test("record parameters only use authorized public IDs and propagate access refusals", async () => {
  const reference = { kind: "record" as const, tableId: Bun.randomUUIDv7(), recordId: Bun.randomUUIDv7() };
  const parameters = WorkflowQueryParametersSchema.parse({ selected: { type: "recordList", value: [reference] } });
  let calls = 0;
  expect(
    await resolveWorkflowQueryParameters(parameters, async (input) => {
      expect(input).toEqual([reference]);
      calls++;
      return ["REC001"];
    }),
  ).toEqual({ ok: true, values: { "params.selected": ["REC001"] } });
  expect(calls).toBe(1);
  await expect(
    resolveWorkflowQueryParameters(parameters, async () => {
      throw new Error("forbidden");
    }),
  ).rejects.toThrow("forbidden");
  expect(await resolveWorkflowQueryParameters({ selected: { type: "record", value: "REC001" } }, async () => [])).toEqual({
    ok: false,
    parameter: "selected",
  });
});

test("planned record parameters are accepted only by planning and still pass through authorization", async () => {
  const reference = { kind: "record", tableId: Bun.randomUUIDv7(), recordId: "dry-run:steps.0", planned: true };
  for (const type of ["record", "recordList"] as const) {
    const parameters = { selected: { type, value: type === "record" ? reference : [reference] } };
    let calls = 0;
    const resolve = async () => {
      calls++;
      return ["REC001"];
    };
    expect(await resolveWorkflowQueryParameters(parameters, resolve)).toEqual({ ok: false, parameter: "selected" });
    expect(calls).toBe(0);
    expect(await resolveWorkflowQueryParameters(parameters, resolve, { allowPlannedRecords: true })).toEqual({
      ok: true,
      values: { "params.selected": type === "record" ? "REC001" : ["REC001"] },
    });
    expect(calls).toBe(1);
    await expect(
      resolveWorkflowQueryParameters(
        parameters,
        async () => {
          throw new Error("forbidden");
        },
        { allowPlannedRecords: true },
      ),
    ).rejects.toThrow("forbidden");
  }
  for (const recordId of [Bun.randomUUIDv7(), "Unknown record", "dry-run:"]) {
    expect(
      await resolveWorkflowQueryParameters({ selected: { type: "record", value: { ...reference, recordId } } }, async () => ["REC001"], {
        allowPlannedRecords: true,
      }),
    ).toEqual({ ok: false, parameter: "selected" });
  }
});
