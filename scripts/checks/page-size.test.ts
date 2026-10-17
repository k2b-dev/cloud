import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { rule } from "./page-size";

const findings = async (source: string, file = "packages/demo/src/export.ts") => {
  const root = await mkdtemp(join(tmpdir(), "cloud-page-size-"));
  try {
    const path = join(root, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source);
    return (await rule.run({ workspaceRoot: root, fix: false, flags: new Set() })).map((finding) => ({
      location: `${relative(root, finding.file ?? "")}:${finding.line}`,
      message: finding.message,
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("reports a clamped pagination literal with its file and line", async () => {
  const found = await findings("service.list({\n  pagination: { page: 1, perPage: 100_000 }\n});");
  expect(found).toHaveLength(1);
  expect(found[0]?.location).toBe("packages/demo/src/export.ts:2");
  expect(found[0]?.message).toContain("paginate() caps perPage at 1000");
  expect(found[0]?.message).toContain("stable order");
});

test("accepts the maximum, variables, and perPage outside pagination", async () => {
  expect(
    await findings(`
      service.list({ pagination: { page: 1, perPage: 1000 } });
      service.list({ pagination: { perPage: someVariable } });
      trace.list({ page: 1, perPage: 2000, offset: 0 });
    `),
  ).toEqual([]);
});

test("ignores test files", async () => {
  expect(await findings("service.list({ pagination: { page: 1, perPage: 100_000 } });", "packages/demo/src/export.test.ts")).toEqual([]);
});

test("checks TSX and the other source roots, including quoted property names", async () => {
  for (const file of ["pwas/demo/export.ts", "docs-site/src/export.tsx"]) {
    expect(await findings('service.list({ "pagination": { "perPage": 1_001 } });', file)).toHaveLength(1);
  }
});
