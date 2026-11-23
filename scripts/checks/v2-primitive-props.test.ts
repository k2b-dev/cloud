import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rule } from "./v2-primitive-props";

const run = async (files: Record<string, string>) => {
  const root = await mkdtemp(join(tmpdir(), "v2-primitive-props-"));
  try {
    await mkdir(join(root, "packages/ui/src/v2"), { recursive: true });
    for (const [name, source] of Object.entries(files)) await writeFile(join(root, "packages/ui/src/v2", name), source);
    const findings = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    return findings.map((finding) => `${finding.file}:${finding.line} ${finding.message.split(";")[0]}`);
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
  expect(findings.sort()).toEqual(
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

test("green: places and meanings as props; tokens, hooks and types are no primitives", async () => {
  const findings = await run({
    "index.ts": [
      'export const Row = (props: { title: string; lead?: string; end?: string; tone?: "ok" | "bad" }) => props.title;',
      "export const Canvas = (props: { label: string; children?: unknown }) => props.label;",
      "export const typeRoles = { meta: { size: 12 } };",
      "export const createReorder = (options: { gap: number }) => options.gap;",
      "export type RowStyle = { style: string };",
    ].join("\n"),
  });
  expect(findings).toEqual([]);
});

test("a tree without the v2 entry has nothing to check", async () => {
  const root = await mkdtemp(join(tmpdir(), "v2-primitive-props-"));
  try {
    expect(await rule.run({ workspaceRoot: root, fix: false, flags: new Set() })).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
