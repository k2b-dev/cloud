import { expect, test } from "bun:test";
import { withinIdleLimit } from "./shared-workstation";

test("the idle condition is built synchronously, so no caller awaits and thereby runs the bare fragment", () => {
  // A Bun SQL fragment is thenable: an async builder would resolve it by executing it as a query of its own.
  expect(withinIdleLimit.constructor.name).toBe("Function");
  expect(withinIdleLimit.length).toBe(2);
});
