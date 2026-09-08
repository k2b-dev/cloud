import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

const check = async (property: string, uiCss = "") => {
  const fixture = await mkdtemp(join(tmpdir(), "cloud-css-check-"));
  try {
    for (const directory of ["scripts", "packages/cloud/src", "packages/cloud/scripts", "packages/ui/src", "packages/example/src/styles"])
      await mkdir(join(fixture, directory), { recursive: true });
    for (const path of [
      "scripts/check-css-architecture.ts",
      "packages/cloud/src/styles",
      "packages/ui/src/styles",
      "packages/ui/src/fonts",
    ])
      await cp(join(root, path), join(fixture, path), { recursive: true });
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
    const child = Bun.spawn([process.execPath, "scripts/check-css-architecture.ts"], { cwd: fixture, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, output: stdout + stderr };
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
};

test("CSS check recognizes UI-owned semantic tokens used by applications", async () => {
  const result = await check("--k2b-surface-muted");
  expect(result.output).toContain("CSS architecture check passed");
  expect(result.code).toBe(0);
});

test("CSS check still rejects undeclared UI tokens", async () => {
  const result = await check("--k2b-missing-token");
  expect(result.code).toBe(1);
  expect(result.output).toContain("--k2b-missing-token is referenced but has no CSS or documented runtime owner");
});

test("CSS comments do not declare a token owner", async () => {
  const result = await check("--k2b-comment-only", "/* .k2b-ui { --k2b-comment-only: red; } */");
  expect(result.code).toBe(1);
  expect(result.output).toContain("--k2b-comment-only is referenced but has no CSS or documented runtime owner");
});
