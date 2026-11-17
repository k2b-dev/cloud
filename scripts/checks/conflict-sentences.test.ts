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
  // Words that are also nouns make no sentence on their own.
  'fail(err.conflict("Preservation hold"));',
  'fail(err.conflict("Booking overlap"));',
  'fail(err.conflict("End date"));',
  'fail(err.conflict("Start time"));',
  'fail(err.conflict("Review request"));',
  'fail(err.conflict("Change request"));',
  'fail(err.conflict("Sign-up"));',
  'fail(err.conflict("Check-in"));',
  // Every literal the argument can end up as.
  'fail(err.conflict(content ? error.message : "Sync operation conflict"));',
  'fail(err.conflict(reason ?? "Access entry"));',
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
  'fail(err.conflict("Review the request first"));',
  'fail(err.conflict(content ? error.message : "Sync operation conflicts with the current state"));',
  'fail(err.conflict(reason ?? "Access entry already exists"));',
])("accepts a sentence, a catalog message or another factory: %s", (source) => {
  expect(checkSource("service.ts", source)).toEqual([]);
});

// A `.ts` file is parsed as TypeScript: as TSX, a generic arrow function reads as a tag and hides the rest of the file.
test("a .ts file is read past a generic arrow function, a .tsx file past JSX", () => {
  expect(checkSource("service.ts", 'const id = <T>(x: T) => x;\nfail(err.conflict("Passkey"));')).toHaveLength(1);
  expect(checkSource("view.tsx", 'const view = <div class="x">{id}</div>;\nfail(err.conflict("Passkey"));')).toHaveLength(1);
});
