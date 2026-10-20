import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rule } from "./boundaries";

test("platform source and scripts cannot import applications; tests may set up with them", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-boundaries-"));
  try {
    for (const dir of ["packages/cloud/src/nested", "packages/cloud/scripts", "packages/notebooks/src"])
      await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ workspaces: { packages: ["packages/cloud", "packages/notebooks"] } }));
    await writeFile(join(root, "packages/cloud/package.json"), JSON.stringify({ exports: { ".": "./src/index.ts" } }));
    const sources = {
      "src/bad.ts": 'import { notes } from "../../notebooks/src/service/notes";',
      "src/nested/bad.ts": 'export { notes } from "../../../notebooks/src/service/notes";',
      "src/nested/setup.integration.test.ts": 'import { migrate } from "../../../notebooks/src/migrate";',
      "scripts/bad.ts": 'const app = import("@k2b/cloud-app-notebooks/integration");',
      "src/absolute.ts": `import "${join(root, "packages/notebooks/src/index")}";`,
      "src/workspace.ts": 'import "packages/notebooks/src/index";',
      "src/allowed.ts": 'import { sharedText } from "./shared-text"; import * as Y from "yjs"; import { ui } from "../../ui/src/index";',
    };
    for (const [file, source] of Object.entries(sources)) await writeFile(join(root, "packages/cloud", file), source);
    const findings = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    expect(findings).toHaveLength(5);
    expect(findings.every((finding) => finding.message.startsWith("The Cloud platform must not import application"))).toBe(true);
    expect(findings.every((finding) => finding.line === 1)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
