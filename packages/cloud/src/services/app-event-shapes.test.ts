import { expect, test } from "bun:test";
import { z } from "zod";
import { appEventShape, appEventShapeId, recordedAppEventShape } from "./app-event-shapes";

test("shape fixtures use declarations only and validate every generated primitive", () => {
  const schema = z.strictObject({
    id: z.uuid(),
    provider: z.enum(["local", "ipa"]),
    label: z.string().min(3).max(20),
    number: z.number().min(5),
    flag: z.boolean(),
    list: z.array(z.string().max(4)).max(3),
  });
  const fixture = appEventShape(z.toJSONSchema(schema));
  expect(schema.safeParse(fixture).success).toBe(true);
  expect(appEventShape(z.toJSONSchema(schema))).toEqual(fixture);
  expect(fixture).toMatchObject({ id: "00000000-0000-4000-8000-000000000001", provider: "local", number: 5, flag: false, list: [] });
});
test("unsupported shape constraints fail visibly instead of copying stored values", () => {
  expect(() => appEventShape({ type: "string", pattern: "^do-not-copy-this-live-.*$", maxLength: 40 })).toThrow("shape_unavailable");
  expect(appEventShape({ type: "integer", maximum: -2 })).toBe(-2);
});

test("recorded shapes collapse scalar values and bucket arrays while preserving optional key presence", () => {
  const schema = z.toJSONSchema(
    z.strictObject({ id: z.uuid(), optional: z.string().max(10).optional(), list: z.array(z.string().max(10)).max(20) }),
  );
  const first = recordedAppEventShape({ id: "private-a", list: ["secret-a", "secret-b"] });
  const same = recordedAppEventShape({ id: "private-b", list: ["other-a", "other-b", "other-c", "other-d"] });
  const different = recordedAppEventShape({ id: "private-c", optional: "private", list: [] });
  expect(first).toEqual(same);
  expect(appEventShapeId("producer.changed", 1, first)).toBe(appEventShapeId("producer.changed", 1, same));
  expect(appEventShapeId("producer.changed", 1, first)).not.toBe(appEventShapeId("producer.changed", 1, different));
  expect(appEventShapeId("producer.changed", 1, first)).not.toBe(appEventShapeId("producer.changed", 2, first));
  const data = appEventShape(schema, 0, first);
  expect(data).toMatchObject({ list: [expect.any(String), expect.any(String)] });
  expect(data).not.toHaveProperty("optional");
  expect(appEventShape(schema, 0, different)).toHaveProperty("optional");
  expect(JSON.stringify(first)).not.toContain("secret");
  expect(JSON.stringify(data)).not.toContain("private");
});
