import { expect, test } from "bun:test";
import { z } from "zod";
import {
  CloudResourceReferenceSchema,
  CloudResourceViewSchema,
  capabilityResultSchema,
  LinkedCloudResourceReferenceSchema,
} from "./capabilities";

const ref = { type: "spaces.item", id: "Itm001" };
const presentation = { context: "Task in IT planning · due 30 Oct", status: "Open" };

test("optional reference presentation survives references, views and result envelopes", () => {
  expect(CloudResourceReferenceSchema.parse(ref)).toEqual(ref);
  const reference = { ...ref, ...presentation };
  expect(CloudResourceReferenceSchema.parse(reference)).toEqual(reference);
  expect(LinkedCloudResourceReferenceSchema.parse({ ...reference, href: "/open/spaces.item/~Itm001" })).toMatchObject(reference);
  expect(
    CloudResourceViewSchema.parse({ ref, title: "Deploy", ...presentation, links: [{ rel: "open", href: "/app/spaces" }] }),
  ).toMatchObject(presentation);
  for (const consumer of [false, true]) {
    expect(capabilityResultSchema(z.null(), { consumer }).parse({ data: null, refs: [reference] }).refs).toEqual([reference]);
  }
});

for (const [field, max] of [
  ["context", 200],
  ["status", 60],
] as const) {
  test(`${field} enforces its presentation bounds in references and views`, () => {
    for (const schema of [CloudResourceReferenceSchema, LinkedCloudResourceReferenceSchema]) {
      for (const length of [1, max]) expect(schema.safeParse({ ...ref, [field]: "x".repeat(length) }).success).toBeTrue();
      for (const length of [0, max + 1]) expect(schema.safeParse({ ...ref, [field]: "x".repeat(length) }).success).toBeFalse();
    }
    for (const length of [0, max + 1]) {
      expect(
        CloudResourceViewSchema.safeParse({
          ref,
          title: "Deploy",
          links: [{ rel: "open", href: "/app/spaces" }],
          [field]: "x".repeat(length),
        }).success,
      ).toBeFalse();
    }
  });
}

test("consumers retain reference identity and known fields when a provider adds optional presentation", () => {
  const reference = { ...ref, ...presentation, futurePresentation: "new" };
  expect(capabilityResultSchema(z.null(), { consumer: true }).parse({ data: null, refs: [reference] }).refs).toEqual([
    { ...ref, ...presentation },
  ]);
  expect(capabilityResultSchema(z.null()).safeParse({ data: null, refs: [reference] }).success).toBeFalse();
});
