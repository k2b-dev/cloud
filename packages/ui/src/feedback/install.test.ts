import { expect, test } from "bun:test";
import { installationPlatform } from "./install";

test("known embedded browsers get external-browser guidance before OS instructions", () => {
  expect(installationPlatform("iPhone Safari Instagram", "iPhone", 1)).toBe("in-app");
  expect(installationPlatform("Android; wv) Chrome", "Linux", 1)).toBe("in-app");
});

test("Apple mobile and desktop Safari get their respective installation steps", () => {
  expect(installationPlatform("iPhone Safari", "iPhone", 1)).toBe("apple-mobile");
  expect(installationPlatform("Macintosh Safari", "MacIntel", 5)).toBe("apple-mobile");
  expect(installationPlatform("Macintosh Safari", "MacIntel", 0)).toBe("apple-desktop");
  expect(installationPlatform("Macintosh Chrome Safari", "MacIntel", 0)).toBe("generic");
});

test("unknown browsers retain general guidance without claiming install support", () => {
  expect(installationPlatform("Android Firefox", "Linux", 1)).toBe("android");
  expect(installationPlatform("Unknown", "Unknown", 0)).toBe("generic");
});
