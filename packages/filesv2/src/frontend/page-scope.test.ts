import { expect, test } from "bun:test";
import { entryRefId } from "../resource-ref";
import { filesPageScope } from "./page-scope";
import type { WorkspaceSnapshot } from "./workspace-state";

const base = {
  id: "base",
  name: "Home",
  area: "cloud",
  kind: "users",
  status: "existing",
  reason: null,
  indexEnabled: true,
  versioningEnabled: true,
} as const;
const file = {
  path: "Docs/report.txt",
  name: "report.txt",
  directory: false,
  size: 4,
  modified: "2026-11-15T00:00:00Z",
  resourceId: "stable-file",
};
const snapshot: WorkspaceSnapshot = {
  source: "/app/filesv2?base=base&path=Docs",
  bases: { items: [base], issues: [], editor: null },
  selectedId: base.id,
  directory: { base, path: "Docs", items: [file], next: null, resourceId: "stable-folder" },
  errorCode: null,
};

test("folder and root pages name the container, including persisted long-path refs", () => {
  expect(filesPageScope(snapshot)).toEqual({ type: "filesv2.folder", id: "stable-folder" });
  expect(filesPageScope({ ...snapshot, directory: { base, path: "", items: [], next: null } })).toEqual({
    type: "filesv2.folder",
    id: entryRefId(base.id, ""),
  });
  expect(
    filesPageScope({ ...snapshot, directory: { base, path: "x/".repeat(1000), items: [], next: null, resourceId: "p:persisted" } }),
  ).toEqual({ type: "filesv2.folder", id: "p:persisted" });
});

test("a single displayed file names the item; a selected folder names its container", () => {
  const source = `${snapshot.source}&file=${file.path}`;
  expect(filesPageScope({ ...snapshot, source })).toEqual({ type: "filesv2.entry", id: "stable-file" });
  expect(filesPageScope({ ...snapshot, source, detail: { base, entry: { ...file, directory: true } } })).toEqual({
    type: "filesv2.folder",
    id: "stable-file",
  });
  const path = "x/".repeat(1000) + "report.txt";
  expect(
    filesPageScope({
      ...snapshot,
      source: `${snapshot.source}&file=${path}`,
      detail: { base, entry: { ...file, path, resourceId: undefined }, resourceId: "p:long-file" },
    }),
  ).toEqual({ type: "filesv2.entry", id: "p:long-file" });
});

test("the editor keeps the file scope and overview, special views and errors clear it", () => {
  const editor = { kind: "markdown", managed: true, base, entry: file, canWrite: true, url: "https://files.invalid/lease" } as const;
  expect(filesPageScope({ ...snapshot, editor })).toEqual({ type: "filesv2.entry", id: "stable-file" });
  for (const view of ["activity", "shares", "favorites", "trash"])
    expect(filesPageScope({ ...snapshot, source: `${snapshot.source}&view=${view}` })).toBeNull();
  expect(filesPageScope({ ...snapshot, directory: null })).toBeNull();
  expect(filesPageScope({ ...snapshot, errorCode: "forbidden" })).toBeNull();
  expect(filesPageScope({ ...snapshot, detail: { base, entry: file }, source: snapshot.source })).toEqual({
    type: "filesv2.folder",
    id: "stable-folder",
  });
});
