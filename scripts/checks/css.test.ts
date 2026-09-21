import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rule } from "./css";

const root = resolve(import.meta.dir, "../..");

const check = async (property: string, uiCss = "") => {
  const fixture = await mkdtemp(join(tmpdir(), "cloud-css-check-"));
  try {
    for (const directory of ["packages/cloud/src", "packages/cloud/scripts", "packages/ui/src", "packages/example/src/styles"])
      await mkdir(join(fixture, directory), { recursive: true });
    for (const path of ["packages/cloud/src/styles", "packages/ui/src/styles", "packages/ui/src/fonts"])
      await cp(join(root, path), join(fixture, path), { recursive: true });
    await writeFile(
      join(fixture, "package.json"),
      JSON.stringify({ workspaces: { packages: ["packages/cloud", "packages/ui", "packages/example"] } }),
    );
    for (const name of ["build.ts", "preload.ts"])
      await writeFile(join(fixture, "packages/cloud/scripts", name), "// src/styles/app.css plugins: [tailwind]\n");
    await writeFile(join(fixture, "packages/ui/src/styles/fixture.css"), uiCss);
    await writeFile(
      join(fixture, "packages/example/src/styles/app.css"),
      `@import "tailwindcss/utilities.css" layer(utilities);
@source "../**/*.{ts,tsx}";
@custom-variant dark (&:where(.dark, .dark *));
.example { color: var(${property}); }
`,
    );
    const findings = await rule.run({ workspaceRoot: fixture, fix: false, flags: new Set() });
    return findings.map((finding) => finding.message);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
};

test("CSS check recognizes UI-owned semantic tokens used by applications", async () => {
  expect(await check("--k2b-surface-muted")).toEqual([]);
});

test("CSS check still rejects undeclared UI tokens", async () => {
  expect(await check("--k2b-missing-token")).toContain("--k2b-missing-token is referenced but has no CSS or documented runtime owner");
});

test("CSS comments do not declare a token owner", async () => {
  expect(await check("--k2b-comment-only", "/* .k2b-ui { --k2b-comment-only: red; } */")).toContain(
    "--k2b-comment-only is referenced but has no CSS or documented runtime owner",
  );
});

test("CSS check rejects removed detail utilities in application JSX", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "cloud-css-check-"));
  try {
    for (const directory of ["packages/cloud/src/styles", "packages/cloud/scripts", "packages/ui/src", "packages/example/src"])
      await mkdir(join(fixture, directory), { recursive: true });
    for (const path of ["packages/cloud/src/styles", "packages/ui/src/styles", "packages/ui/src/fonts"])
      await cp(join(root, path), join(fixture, path), { recursive: true });
    await writeFile(
      join(fixture, "package.json"),
      JSON.stringify({ workspaces: { packages: ["packages/cloud", "packages/ui", "packages/example"] } }),
    );
    for (const name of ["build.ts", "preload.ts"])
      await writeFile(join(fixture, "packages/cloud/scripts", name), "// src/styles/app.css plugins: [tailwind]\n");
    await writeFile(join(fixture, "packages/example/src/Page.tsx"), 'export const Page = () => <div class="detail-stack">x</div>;\n');
    const findings = await rule.run({ workspaceRoot: fixture, fix: false, flags: new Set() });
    expect(findings.map((finding) => finding.message)).toContain("removed detail-* utility at line 1");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
