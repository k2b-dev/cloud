import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { katexStylesHref } from "../src/lib/katex-assets";
import { buildMathAssets } from "./math-assets";

test("the page stylesheet URL resolves to KaTeX with external WOFF2 fonts", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "notebooks-math-"));
  try {
    await buildMathAssets(directory);
    const stylesheet = resolve(directory, katexStylesHref.slice("/public/".length));
    const css = await readFile(stylesheet, "utf8");
    expect(css).not.toContain("data:");
    expect(css).not.toContain(".woff)");
    expect(css).not.toContain(".ttf)");
    const sources = [...css.matchAll(/url\(([^)]+)\)/g)];
    expect(sources.length).toBeGreaterThan(0);
    for (const [, url] of sources) {
      const bytes = await readFile(resolve(stylesheet, "..", url!));
      expect(bytes.subarray(0, 4).toString()).toBe("wOF2");
    }
    const original = await readFile(Bun.resolveSync("katex/dist/katex.min.css", import.meta.dir), "utf8");
    const declarations = (value: string) => value.replace(/src:[^;]+;/g, "");
    expect(declarations(css)).toBe(declarations(original));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
