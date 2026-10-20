import { expect, test } from "bun:test";
import { crypto } from "@k2b/stdlib";
import { TEST_SHORT_ID_MARK, testShortId } from "./test-short-id";

for (const length of [6, 8, 10]) {
  test(`fixture short IDs are unique ${length}-character marked alphanumerics`, () => {
    const ids = Array.from({ length: 1_000 }, () => testShortId(length));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => new RegExp(`^[0-9A-Za-z]{${length}}$`).test(id) && id.startsWith(TEST_SHORT_ID_MARK))).toBe(true);
  });
}

test("fixture IDs default to six characters and reject lengths without a counter", () => {
  expect(testShortId()).toMatch(/^o[0-9a-z]{5}$/);
  for (const length of [-1, 0, 1]) expect(() => testShortId(length)).toThrow("at least two characters");
});

test("service IDs never contain the fixture mark in either case", () => {
  const ids = Array.from({ length: 10_000 }, () => crypto.common.readableId(6));
  expect(ids.filter((id) => /[oO]/.test(id))).toEqual([]);
});
