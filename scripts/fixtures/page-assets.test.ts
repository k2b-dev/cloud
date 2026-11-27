import { expect, test } from "bun:test";
import { fixtureAsset, fixtureAssetResponse, pageScript } from "./page-assets";

test("an asset keeps its address for the same text and is served with its type and a long cache lifetime", async () => {
  const href = fixtureAsset(".k2b-ui { color: red }", "css");
  expect(href).toMatch(/^\/__fixture\/[0-9a-z]+\.css$/);
  expect(fixtureAsset(".k2b-ui { color: red }", "css")).toBe(href);
  expect(fixtureAsset(".k2b-ui { color: blue }", "css")).not.toBe(href);
  const response = fixtureAssetResponse(href)!;
  expect(response.headers.get("content-type")).toBe("text/css; charset=utf-8");
  expect(response.headers.get("cache-control")).toContain("immutable");
  expect(await response.text()).toBe(".k2b-ui { color: red }");
  expect(fixtureAssetResponse("/__fixture/unknown.css")).toBeUndefined();
  expect(fixtureAssetResponse("/")).toBeUndefined();
});

test("a page script is one minified file, and a build that splits into chunks is refused", async () => {
  const entry = "/virtual/page-assets-entry.ts";
  const script = await pageScript({ entrypoints: [entry], files: { [entry]: "const greeting = 'hello';\nconsole.log(greeting);\n" } });
  expect(script).toContain("hello");
  expect(script).not.toContain("const greeting");
  const lazy = "/virtual/page-assets-lazy.ts";
  await expect(
    pageScript({
      entrypoints: [entry],
      splitting: true,
      format: "esm",
      files: { [entry]: `void import("${lazy}");`, [lazy]: "export const later = 1;" },
    }),
  ).rejects.toThrow("one entry point and no split chunks");
});
