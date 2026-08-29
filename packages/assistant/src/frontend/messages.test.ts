import { expect, test } from "bun:test";
import { assistantMessages } from "./messages";
import { missingAssistantGermanText } from "./ui-copy";

test("Assistant messages contain matching locale contracts", () => {
  expect(assistantMessages.check()).toEqual([]);
});

test("literal Assistant text calls have a German translation", async () => {
  const values = new Set<string>();
  const sourceFiles = new Bun.Glob("**/*.{ts,tsx}");
  for await (const path of sourceFiles.scan({ cwd: import.meta.dir, absolute: true })) {
    if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) continue;
    const source = await Bun.file(path).text();
    for (const match of source.matchAll(/\b(?:text|assistantBrowserText)\(\s*(["'])(.*?)\1/g)) {
      if (match[2]) values.add(match[2]);
    }
  }

  expect(missingAssistantGermanText(values)).toEqual([]);
});
