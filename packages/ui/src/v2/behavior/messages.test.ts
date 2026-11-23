import { expect, test } from "bun:test";
import { checkBehaviorMessages } from "./messages";

test("every locale has every behaviour message", () => {
  expect(() => checkBehaviorMessages()).not.toThrow();
});
