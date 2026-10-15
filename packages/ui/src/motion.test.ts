import { expect, test } from "bun:test";
import { prefersReducedMotion } from "./motion";

test("less motion is false on the server", () => {
  expect(typeof window).toBe("undefined");
  expect(typeof document).toBe("undefined");
  expect(prefersReducedMotion()).toBe(false);
});
