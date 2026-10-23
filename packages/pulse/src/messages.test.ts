import { expect, test } from "bun:test";
import { pulseMessages } from "./messages";

test("Pulse messages contain matching locale contracts", () => {
  expect(pulseMessages.check()).toEqual([]);
});
