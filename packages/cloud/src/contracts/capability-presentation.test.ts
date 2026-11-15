import { expect, test } from "bun:test";
import { z } from "zod";
import { BlockViewSchema, bindView } from "../blocks";
import { CapabilityActionReviewSchema, capabilityDataAtPath, capabilityResultJsonSchema, capabilityResultSchema } from "./capabilities";

const view = {
  version: 1,
  blocks: [{ kind: "Table", title: "Amounts", rows: { from: [] }, columns: [{ path: ["amount"], label: "Amount", type: "number" }] }],
};

test("views reference canonical data without changing exact decimal strings or storing bound rows", () => {
  const data = [{ amount: "12345678901234567890.123400" }];
  const result = capabilityResultSchema(z.array(z.object({ amount: z.string() }))).parse({ data, view });
  expect(result.data).toEqual(data);
  expect<unknown>(result.view).toEqual(view);
  expect(bindView(result.view, result.data).blocks[0]).toMatchObject({ rows: data });
});

test("the contract cut rejects old presentation and invalid views for producers and consumers", () => {
  for (const consumer of [false, true]) {
    const schema = capabilityResultSchema(z.unknown(), { consumer });
    expect(
      schema.safeParse({ data: [], presentation: { kind: "table", rowsPath: [], columns: [{ path: [], label: "Value" }] } }).success,
    ).toBeFalse();
    expect(schema.safeParse({ data: [], view: { version: 2, blocks: [] } }).success).toBeFalse();
    expect(schema.safeParse({ data: {}, view }).success).toBeFalse();
    expect(schema.safeParse({ data: [], view }).success).toBeTrue();
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(schema.safeParse({ data: cycle, view }).success).toBeFalse();
    let reads = 0;
    expect(
      schema.safeParse({
        data: [],
        get view() {
          reads++;
          return view;
        },
      }).success,
    ).toBeFalse();
    expect(reads).toBe(0);
  }
});

test("paths stay bounded, do not read prototypes or invoke getters", () => {
  expect(capabilityDataAtPath({}, ["constructor"])).toBeUndefined();
  let reads = 0;
  expect(
    capabilityDataAtPath(
      {
        get secret() {
          reads++;
          return 42;
        },
      },
      ["secret"],
    ),
  ).toBeUndefined();
  expect(reads).toBe(0);
  expect(capabilityDataAtPath({ values: { "a.b": false } }, ["values", "a.b"])).toBeFalse();
  expect(BlockViewSchema.safeParse({ ...view, blocks: [{ ...view.blocks[0], rows: { from: Array(17).fill("x") } }] }).success).toBeFalse();
});

test("published result schemas expose view as an open object", () => {
  const schema = capabilityResultJsonSchema({ type: "object", properties: { answer: { type: "number" } }, required: ["answer"] });
  expect(capabilityDataAtPath(schema, ["properties", "view"])).toMatchObject({ type: "object", additionalProperties: {} });
  expect(capabilityDataAtPath(schema, ["properties", "presentation"])).toBeUndefined();
});

test("Markdown approval details require block display", () => {
  const review = (display?: string) => ({
    message: "Review access",
    details: [{ label: "Access", value: "**Read calendar**", format: "markdown", display }],
  });
  expect(CapabilityActionReviewSchema.safeParse(review("block")).success).toBeTrue();
  expect(CapabilityActionReviewSchema.safeParse(review("inline")).success).toBeFalse();
  expect(CapabilityActionReviewSchema.safeParse(review()).success).toBeFalse();
});
