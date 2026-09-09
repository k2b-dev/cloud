import { expect, test } from "bun:test";
import { z } from "zod";
import { CapabilityTablePresentationSchema, capabilityDataAtPath, capabilityResultSchema } from "./capabilities";

test("table metadata references canonical data without transforming exact values", () => {
  const data = [{ amount: "12345678901234567890.123400" }];
  const result = capabilityResultSchema(z.array(z.object({ amount: z.string() }))).parse({
    data,
    presentation: { kind: "table", rowsPath: [], columns: [{ path: ["amount"], label: "Amount", format: "number" }] },
  });
  expect(result.data).toEqual(data);
  expect(capabilityDataAtPath(result.data[0], ["amount"])).toBe(data[0]!.amount);
});

test("consumer ignores unknown presentation without losing canonical data; provider stays strict", () => {
  const result = { data: { answer: 42 }, presentation: { kind: "future-widget" } };
  const data = z.object({ answer: z.number() });
  expect(capabilityResultSchema(data).safeParse(result).success).toBeFalse();
  expect(capabilityResultSchema(data, { consumer: true }).parse(result).data).toEqual(result.data);
  expect(capabilityResultSchema(data, { consumer: true }).parse(result).presentation).toBeUndefined();
});

test("metadata is bounded and paths never read inherited properties or invoke getters", () => {
  expect(capabilityDataAtPath({}, ["constructor"])).toBeUndefined();
  expect(
    capabilityDataAtPath(
      {
        get secret() {
          throw new Error("must not run");
        },
      },
      ["secret"],
    ),
  ).toBeUndefined();
  expect(capabilityDataAtPath({ values: { "a.b": false } }, ["values", "a.b"])).toBeFalse();
  expect(CapabilityTablePresentationSchema.safeParse({ kind: "table", rowsPath: [], columns: [] }).success).toBeFalse();
  expect(
    CapabilityTablePresentationSchema.safeParse({ kind: "table", rowsPath: Array(17).fill("x"), columns: [{ path: [], label: "x" }] })
      .success,
  ).toBeFalse();
});
