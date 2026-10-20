import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("Mail neither imports nor renders a moved-path hint", async () => {
  const violations: string[] = [];
  const root = resolve(import.meta.dir, "..");
  const name = ["Moved", "Hint"].join("");
  const render = new RegExp(`<(?:[\\w$]+\\.)?${name}\\b|\\bcreateComponent\\(\\s*(?:[\\w$]+\\.)?${name}\\b`);
  for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan(root)) {
    const source = await Bun.file(resolve(root, file)).text();
    const imports = [...source.matchAll(/\bimport\s+(?:type\s+)?[^;]+?\bfrom\s*["'][^"']+["']/g)];
    if (imports.some(([declaration]) => declaration.includes(name)) || render.test(source)) violations.push(file);
  }
  expect(violations).toEqual([]);
});
