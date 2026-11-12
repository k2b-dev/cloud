import { expect, test } from "bun:test";
import { resolve } from "node:path";

/**
 * Mail v5 tells people once where a moved control went (`MovedHint`). Such a hint is only allowed where Mail decides
 * from the person's server-stored seen hints, so it never comes back after "Got it" and the first render matches.
 */
const OWNERS = ["_components/MailReaderHead.tsx"];

test("Mail renders a moved-path hint only where the server-stored seen hints decide it", async () => {
  const violations: string[] = [];
  const root = resolve(import.meta.dir, "..");
  const name = ["Moved", "Hint"].join("");
  const render = new RegExp(`<(?:[\\w$]+\\.)?${name}\\b|\\bcreateComponent\\(\\s*(?:[\\w$]+\\.)?${name}\\b`);
  for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan(root)) {
    if (file.includes(".test.") || OWNERS.some((owner) => `frontend/${owner}` === file)) continue;
    const source = await Bun.file(resolve(root, file)).text();
    const imports = [...source.matchAll(/\bimport\s+(?:type\s+)?[^;]+?\bfrom\s*["'][^"']+["']/g)];
    if (imports.some(([declaration]) => declaration.includes(name)) || render.test(source)) violations.push(file);
  }
  expect(violations).toEqual([]);
  for (const owner of OWNERS) expect(await Bun.file(resolve(import.meta.dir, owner)).text()).toContain("seen");
});
