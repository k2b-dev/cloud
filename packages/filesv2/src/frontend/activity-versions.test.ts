import { expect, test } from "bun:test";
import { entry, hidden } from "../../test/history-fixtures";
import type { ActivityEntry, ActivitySide } from "../activity-contracts";
import type { FileEntry, FileVersion } from "../contracts";
import { activityVersion } from "./activity-versions";

const file: FileEntry = {
  name: "Notes.txt",
  path: "Notes.txt",
  directory: false,
  size: 24,
  modified: "2026-10-20T12:30:00.000Z",
  revision: "current",
};
const versions: FileVersion[] = [
  { id: "v2", created: "2026-10-19T10:00:00.000Z", size: 20, pinned: false, comment: null, author: null },
  { id: "v1", created: "2026-10-18T10:00:00.000Z", size: 10, pinned: false, comment: null, author: null },
];
const side: Extract<ActivitySide, { visibility: "full" }> = {
  visibility: "full",
  source: "current",
  name: file.name,
  path: file.path,
  root: "cloud",
  baseId: "binding",
  publicBaseId: "cloud:groups:team",
  itemId: "item",
  directory: false,
  size: 24,
  revision: "current",
};
const change = (patch: Partial<ActivityEntry> = {}) => entry({ action: "file.overwrite", after: side, ...patch });

test("only a completed change producing the current revision offers the previous version", () => {
  expect(activityVersion(change(), file, versions)).toEqual({ current: 3, restorable: 2 });
  expect(activityVersion(change({ state: "pending" }), file, versions)).toBeNull();
  expect(activityVersion(change({ after: { ...side, revision: "older" } }), file, versions)).toBeNull();
  expect(activityVersion(change({ after: hidden }), file, versions)).toBeNull();
  expect(activityVersion(change({ action: "item.move" }), file, versions)).toBeNull();
});

test("saved versions use their exact IDs, never a revision or a date guess", () => {
  expect(activityVersion(change({ after: { ...side, versionId: "v1", revision: null } }), file, versions)).toEqual({
    current: 1,
    restorable: null,
  });
  expect(activityVersion(change({ after: { ...side, revision: "v1" } }), file, versions)).toBeNull();
  expect(activityVersion(change({ after: { ...side, versionId: "gone", revision: null } }), file, versions)).toBeNull();
});

test("read-only files and missing saved content never offer a restore", () => {
  expect(activityVersion(change(), { ...file, actions: { write: false, move: false, share: false } }, versions)).toEqual({
    current: 3,
    restorable: null,
  });
  expect(activityVersion(change(), file, [])).toEqual({ current: 1, restorable: null });
});
