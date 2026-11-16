import { expect, test } from "bun:test";
import { checkSource } from "./conflict-sentences";

test.each([
  'fail(err.conflict("Passkey"));',
  'fail(err.conflict(""));',
  'fail(err.conflict(`File "${to}"`));',
  "fail(err.conflict(`${name}`));",
  'fail(err.conflict("API key"));',
  'fail(err.conflict("Running turn"));',
  'fail(err.conflict("Tag with that name"));',
  'fail(err.conflict("Opening-hour exception for this date"));',
  'fail(err.conflict("Document capture idempotency conflict."));',
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
  'fail(err.conflict("Compose template changed; reload it and retry"));',
  'fail(err.conflict("Complete all blocking tasks first"));',
  "fail(err.conflict(`Several provider folders claim the ${role} role; configure one explicitly`));",
  'fail(err.conflict("Automatic reply step conflicts with a different request"));',
  'fail(err.conflict("Workflow is running; stop it first"));',
])("accepts a sentence, a catalog message or another factory: %s", (source) => {
  expect(checkSource("service.ts", source)).toEqual([]);
});
