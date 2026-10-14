import { describe, expect, test } from "bun:test";

describe("Mail SSR island entries", () => {
  test("use one discoverable default export", async () => {
    const files = [...new Bun.Glob("**/*.island.tsx").scanSync({ cwd: import.meta.dir })].sort();
    const missing: string[] = [];

    for (const file of files) {
      const source = await Bun.file(`${import.meta.dir}/${file}`).text();
      if (!/\bexport\s+(?:default\b|\{\s*default\s*\}\s*from\b)/u.test(source)) missing.push(file);
    }

    expect(files.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});
