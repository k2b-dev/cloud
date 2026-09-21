import { expect, test } from "bun:test";
import { getRecordWritableFieldType } from "./index";
import { resourceHandler } from "./resource";

const ref = { type: "filesv2.entry", id: "folder/a.pdf", title: "Agreement" };
test("resource values retain stable identity and a presentation label", () => {
  expect(resourceHandler.validate(ref, {}, true)).toEqual({ ok: true, value: ref });
  expect(resourceHandler.validate({ type: ref.type, id: ref.id }, {}, false).ok).toBe(true);
  expect(getRecordWritableFieldType("resource")).toBe(resourceHandler);
});
test("resource fields reject URLs, permissions, malformed identities and multiple values", () => {
  for (const value of [
    "https://example.com",
    [ref],
    { type: "file", id: "x" },
    { ...ref, href: "/secret" },
    { ...ref, token: "secret" },
    { ...ref, id: "" },
    { ...ref, title: "x".repeat(501) },
  ]) {
    expect(resourceHandler.validate(value, {}, false).ok).toBe(false);
  }
});
test("empty references and invalid config honor field validation", () => {
  expect(resourceHandler.validate(null, {}, false)).toEqual({ ok: true, value: null });
  expect(resourceHandler.validate(null, {}, true).ok).toBe(false);
  expect(resourceHandler.validate(ref, { unexpected: true }, false).ok).toBe(false);
});

test("resource config remains scalar and rejects speculative options", () => {
  expect(resourceHandler.configSchema.safeParse({}).success).toBe(true);
  expect(resourceHandler.configSchema.safeParse({ multiple: true }).success).toBe(false);
});
