import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureAsset, fixtureAssetResponse, pageCss, pageScript } from "./page-assets";

const dir = mkdtempSync(join(tmpdir(), "page-assets-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("page CSS is one build for the same entries, joined under the layer order, and a failed build is built again", async () => {
  const app = join(dir, "app.css");
  const shell = join(dir, "shell.css");
  writeFileSync(app, ".app-mark { color: red; }\n");
  writeFileSync(shell, ".shell-mark { color: blue; }\n");
  // two calls at once share one build
  const first = pageCss([app, shell]);
  expect(pageCss([app, shell])).toBe(first);
  const css = await first;
  expect(css.startsWith("@layer properties, theme, base, components, utilities;\n")).toBe(true);
  expect(css.indexOf(".app-mark")).toBeLessThan(css.indexOf(".shell-mark"));
  // a stylesheet that is not there yet fails, and the next call builds it instead of repeating the failure
  const later = join(dir, "later.css");
  await expect(pageCss([later])).rejects.toThrow();
  writeFileSync(later, ".later-mark { color: green; }\n");
  expect(await pageCss([later])).toContain(".later-mark");
});

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
