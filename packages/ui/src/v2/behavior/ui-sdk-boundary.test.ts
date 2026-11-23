import { expect, test } from "bun:test";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "../../..");

// `@ui-sdk/core` is a pinned beta whose renderer entry is internal. Inside @k2b/ui only the v2 behaviour layer and its
// contract tests may import it, so an update touches one folder and the contract tests cover all of it. (Apps never
// import it; the repository check owns that rule.)
test("inside @k2b/ui only the v2 behaviour layer imports @ui-sdk", async () => {
  const offenders: string[] = [];
  for (const root of ["src", "test", "scripts", "fixture"]) {
    for await (const path of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: resolve(packageRoot, root) })) {
      const file = `${root}/${path}`;
      if (file.startsWith("src/v2/behavior/") || file.startsWith("test/v2-behavior/")) continue;
      if (/from\s+["']@ui-sdk\//.test(await Bun.file(resolve(packageRoot, file)).text())) offenders.push(file);
    }
  }
  expect(offenders).toEqual([]);
});

test("@ui-sdk/core is pinned to one exact version", async () => {
  const manifest: { dependencies?: Record<string, string> } = await Bun.file(resolve(packageRoot, "package.json")).json();
  expect(manifest.dependencies?.["@ui-sdk/core"]).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
});
