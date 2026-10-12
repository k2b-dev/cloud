import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { staticImportClosure } from "../../../../scripts/fixtures/island-closure";

test("the mailbox island keeps Zod out of its static import closure", async () => {
  const closure = await staticImportClosure([resolve(import.meta.dir, "MailWorkspace.island.tsx")]);
  const zod = closure.filter((path) => path.includes("node_modules/zod"));
  if (zod.length > 0) {
    const importers = [];
    for (const path of closure.filter((path) => !path.includes("node_modules"))) {
      if (/import\s+(?!type\b)[^;]*\bfrom\s+["']zod(?:\/[^"']*)?["']/.test(await Bun.file(path).text())) importers.push(path);
    }
    throw new Error(`Zod reached the mailbox first load through:\n${importers.join("\n")}\nZod inputs:\n${zod.join("\n")}`);
  }
  expect(zod).toEqual([]);
}, 60_000);
