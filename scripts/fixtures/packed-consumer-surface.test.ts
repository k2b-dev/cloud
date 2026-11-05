import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packedTypeSurface, packedTypesMatch } from "./packed-consumer-surface";

const root = await mkdtemp(join(tmpdir(), "packed-type-surface-"));
afterAll(() => rm(root, { recursive: true, force: true }));
let sequence = 0;
const pack = async (files: Record<string, string>, exports: Record<string, unknown> = { ".": "./dist/types/index.d.ts" }) => {
  const archive = join(root, `${sequence++}.tgz`);
  await Bun.write(
    archive,
    await new Bun.Archive(
      {
        "package/package.json": JSON.stringify({ name: "@fixture/ui", version: "1.0.0", exports }),
        ...files,
      },
      { compress: "gzip" },
    ).bytes(),
  );
  return archive;
};

test("same-version published types do not hide an added workspace prop", async () => {
  const published = await pack({ "package/dist/types/index.d.ts": "export type MainPaneProps = { label: string };" });
  const workspace = await pack({ "package/dist/types/index.d.ts": "export type MainPaneProps = { label: string; heading?: string };" });
  expect(await packedTypesMatch(workspace, published)).toBe(false);
});

test("archive order, documentation and source maps do not change the type surface", async () => {
  const one = await pack({
    "package/dist/types/index.d.ts": "export type Props = { label: string };",
    "package/README.md": "Published readme",
    "package/dist/index.js.map": "published map",
  });
  const two = await pack({
    "package/dist/index.js.map": "local map",
    "package/README.md": "Current readme",
    "package/dist/types/index.d.ts": "export type Props = { label: string };",
  });
  expect(await packedTypesMatch(one, two)).toBe(true);
});

test("added and removed declaration files count even if the main declaration is unchanged", async () => {
  const published = await pack({ "package/dist/types/index.d.ts": "export {};" });
  const workspace = await pack({
    "package/dist/types/index.d.ts": "export {};",
    "package/dist/types/extra.d.ts": "export type Extra = string;",
  });
  expect(await packedTypesMatch(workspace, published)).toBe(false);
  expect(await packedTypesMatch(published, workspace)).toBe(false);
});

test("SSR and Editor source packages compare their shipped TypeScript", async () => {
  const published = await pack({ "package/src/index.ts": "export const version = 1;" });
  const workspace = await pack({ "package/src/index.ts": "export const version = 2;" });
  expect(await packedTypesMatch(workspace, published)).toBe(false);
});

test("changed public entrypoints count even with identical declarations", async () => {
  const files = { "package/dist/types/index.d.ts": "export {};" };
  const published = await pack(files);
  const workspace = await pack(files, { ".": "./dist/types/other.d.ts" });
  expect(await packedTypesMatch(workspace, published)).toBe(false);
});

test("a tarball without a TypeScript surface cannot silently match", async () => {
  const empty = await pack({ "package/README.md": "No types" });
  await expect(packedTypeSurface(empty)).rejects.toThrow("no TypeScript surface");
});

test("conditional exports order changes the type surface", async () => {
  const files = { "package/dist/types/index.d.ts": "export {};" };
  const typesFirst = await pack(files, { ".": { types: "./dist/types/index.d.ts", import: "./dist/index.js" } });
  const importFirst = await pack(files, { ".": { import: "./dist/index.js", types: "./dist/types/index.d.ts" } });
  expect(await packedTypesMatch(typesFirst, importFirst)).toBe(false);
});
