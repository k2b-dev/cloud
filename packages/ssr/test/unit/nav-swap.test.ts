import { expect, test } from "bun:test";

test("nav imports and page swap APIs are safe without DOM globals", async () => {
  expect(typeof window).toBe("undefined");
  expect(typeof document).toBe("undefined");
  const { installPageSwap, swapPage } = await import("../../src/nav");
  const uninstall = installPageSwap();
  expect(typeof uninstall).toBe("function");
  expect(() => uninstall()).not.toThrow();
  await expect(swapPage("/app/page")).resolves.toBeUndefined();
});
