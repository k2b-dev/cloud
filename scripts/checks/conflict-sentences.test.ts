import { expect, test } from "bun:test";
import { checkSource } from "./conflict-sentences";

test.each([
  'fail(err.conflict("Passkey"));',
  'fail(err.conflict(""));',
  'fail(err.conflict(`File "${to}"`));',
  "fail(err.conflict(`${name}`));",
])("reports a subject where a sentence belongs: %s", (source) => {
  const [finding] = checkSource("service.ts", source);
  expect(finding?.line).toBe(1);
  expect(finding?.message).toContain('"Passkey already exists"');
});

test.each([
  'fail(err.conflict("Passkey already exists"));',
  'fail(err.conflict(`File "${to}" already exists`));',
  "fail(err.conflict(t.recordChanged));",
  "fail(err.conflict(error.message));",
  'fail(other.conflict("Passkey"));',
])("accepts a sentence, a catalog message or another factory: %s", (source) => {
  expect(checkSource("service.ts", source)).toEqual([]);
});
