import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rule } from "./v2-primitive-props";

// The rule reads packages/ui/tsconfig.json; the fixtures get a small one of their own.
const tsconfig = JSON.stringify({
  compilerOptions: { strict: true, target: "ESNext", module: "ESNext", moduleResolution: "Bundler", noEmit: true, types: [] },
  include: ["./src/**/*.ts"],
});

const run = async (files: Record<string, string>, { config = true } = {}) => {
  const root = await mkdtemp(join(tmpdir(), "v2-primitive-props-"));
  try {
    await mkdir(join(root, "packages/ui/src/v2"), { recursive: true });
    if (config) await writeFile(join(root, "packages/ui/tsconfig.json"), tsconfig);
    for (const [name, source] of Object.entries(files)) await writeFile(join(root, "packages/ui/src/v2", name), source);
    const findings = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    return findings.map((finding) => `${finding.file}:${finding.line ?? 0} ${finding.message.split(";")[0]}`).sort();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("red: layout props on a primitive, a dotted part, a union member and an inherited attribute type", async () => {
  const findings = await run({
    "index.ts": 'export { Row } from "./row";\nexport { Workspace } from "./workspace";\nexport { Notice, Band } from "./notice";\n',
    "row.ts": "export const Row = (props: { title: string; class?: string; style?: string }) => props.title;\n",
    "workspace.ts": [
      "const Main = (props: { gap?: number }) => props.gap;",
      "export const Workspace = Object.assign((props: { children?: unknown }) => props.children, { Main });",
    ].join("\n"),
    "notice.ts": [
      "type Html = { className?: string; id?: string };",
      'type NoticeProps = { tone: "ok" } | { tone: "bad"; action: string; size?: "sm" };',
      "export const Notice = (props: NoticeProps) => props.tone;",
      "export function Band(props: Html & { tone?: string }) { return props.tone; }",
    ].join("\n"),
  });
  expect(findings).toEqual(
    [
      "packages/ui/src/v2/notice.ts:3 Notice accepts `size`",
      "packages/ui/src/v2/notice.ts:4 Band accepts `className`",
      "packages/ui/src/v2/row.ts:1 Row accepts `class`",
      "packages/ui/src/v2/row.ts:1 Row accepts `style`",
      // A part points at the place where the primitive exposes it.
      "packages/ui/src/v2/workspace.ts:2 Workspace.Main accepts `gap`",
    ].sort(),
  );
});

test("red: parts deeper than one level", async () => {
  const findings = await run({
    "index.ts": [
      "const Deep = (props: { gap?: number }) => props.gap;",
      "const Head = Object.assign((props: { title: string }) => props.title, { Deep });",
      "export const Shell = Object.assign((props: { children?: unknown }) => props.children, { Head });",
    ].join("\n"),
  });
  expect(findings).toEqual(["packages/ui/src/v2/index.ts:2 Shell.Head.Deep accepts `gap`"]);
});

test("red: a type the checker cannot resolve fails instead of passing as any", async () => {
  const findings = await run({
    "index.ts": ['import type { RowProps } from "./missing";', "export const Row = (props: RowProps) => props;"].join("\n"),
  });
  expect(findings).toEqual([
    "packages/ui/src/v2/index.ts:1 TS2307 Cannot find module './missing' or its corresponding type declarations.",
    "packages/ui/src/v2/index.ts:2 Row takes props of type any",
  ]);
});

test("red: props that accept any name", async () => {
  const findings = await run({
    "index.ts": [
      "export const Loose = (props: { title: string; [key: string]: unknown }) => props.title;",
      "export const Unknown = (props: unknown) => props;",
      "export const Generic = <P,>(props: P) => props;",
      "export const Anything: any = () => null;",
    ].join("\n"),
  });
  expect(findings).toEqual(
    [
      "packages/ui/src/v2/index.ts:1 Loose takes props with an index signature, which accept any name",
      "packages/ui/src/v2/index.ts:2 Unknown takes props of type unknown",
      "packages/ui/src/v2/index.ts:3 Generic takes props of an unconstrained type parameter",
      "packages/ui/src/v2/index.ts:4 Anything has the type any",
    ].sort(),
  );
});

test("green: places and meanings as props; tokens, hooks and types are no primitives", async () => {
  const findings = await run({
    "index.ts": [
      'export const Row = (props: { title: string; lead?: string; end?: string; tone?: "ok" | "bad" }) => props.title;',
      "export const Canvas = (props: { label: string; children?: unknown }) => props.label;",
      "const Main = (props: { title: string }) => props.title;",
      "export const Workspace = Object.assign((props: { children?: unknown }) => props.children, { Main });",
      "export const typeRoles = { meta: { size: 12 } };",
      "export const createReorder = (options: { gap: number }) => options.gap;",
      "export type RowStyle = { style: string };",
    ].join("\n"),
  });
  expect(findings).toEqual([]);
});

test("a tree without the v2 entry has nothing to check; one without the compiler options fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "v2-primitive-props-"));
  try {
    expect(await rule.run({ workspaceRoot: root, fix: false, flags: new Set() })).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  expect(await run({ "index.ts": "export const Row = (props: { title: string }) => props.title;\n" }, { config: false })).toEqual([
    "packages/ui/tsconfig.json:0 missing",
  ]);
});
