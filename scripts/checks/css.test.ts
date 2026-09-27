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

test("CSS check accepts --ui-focus only as a box-shadow", async () => {
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
    await writeFile(
      join(fixture, "packages/example/src/Page.tsx"),
      `export const Page = (props: { color: string }) => (
  <div class="focus-visible:outline-none focus-visible:[box-shadow:var(--ui-focus)] focus-visible:shadow-[var(--ui-focus)]">
    <div style={\`border-color:\${props.color};box-shadow:var(--ui-focus),inset 0 2px 5px black\`} />
    <div style={{ boxShadow: "var(--ui-focus)", "--ring": "var(--ui-focus)" }} />
    <div class="border border-[var(--ui-focus)] bg-[color-mix(in_srgb,var(--ui-focus)_12%,transparent)]" />
    <button type="button" class="focus-visible:outline-2 focus-visible:outline-[var(--ui-focus)]" />
    <div style={{ "outline-color": "var(--ui-focus)" }} />
  </div>
);
`,
    );
    await writeFile(
      join(fixture, "packages/example/src/ring.ts"),
      `// Focus: var(--ui-focus) stays a box-shadow.
const palette = { color: "red" };
export const ring = "var(--ui-focus)";
export const toggled = (active: boolean) => ({ "box-shadow": active ? "none" : "var(--ui-focus)", palette });
export const paint = (element: HTMLElement) => {
  element.style.boxShadow = "var(--ui-focus)";
  element.style.borderColor = "var(--ui-focus)";
};
`,
    );
    await writeFile(join(fixture, "packages/example/src/Page.test.tsx"), 'expect(style).toStartWith("var(--ui-focus),");\n');
    await writeFile(
      join(fixture, "packages/example/src/focus.css"),
      ".row:focus-visible {\n  box-shadow:\n    var(--ui-shadow-surface),\n    var(--ui-focus);\n}\n.marquee { border: 1px solid var(--ui-focus); }\n/* Focus: keep var(--ui-focus) as box-shadow */\n",
    );
    const findings = await rule.run({ workspaceRoot: fixture, fix: false, flags: new Set() });
    const misuses = findings
      .filter((finding) => finding.message.includes("--ui-focus"))
      .map((finding) => `${finding.file!.slice(fixture.length + 1)}:${finding.line} ${finding.message.split(" ")[0]}`)
      .toSorted();
    expect(misuses).toEqual([
      "packages/example/src/Page.tsx:5 bg",
      "packages/example/src/Page.tsx:5 border",
      "packages/example/src/Page.tsx:6 outline",
      "packages/example/src/Page.tsx:7 outline-color",
      "packages/example/src/focus.css:6 border",
      "packages/example/src/ring.ts:7 borderColor",
    ]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
