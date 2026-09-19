import { expect, test } from "bun:test";
import type { RootInfo, Stats } from "@k2b/filegate";
import { rootSummary } from "./root-summary";

const root = (stats: Stats | null): RootInfo => ({
  name: "files",
  managed: false,
  execution: false,
  index: { enabled: true, rebuilding: false, scanned: 0, lastBuilt: null, durationMs: 0 },
  stats,
  versioning: { enabled: false, keep: { last: 0, hourly: 0, daily: 0, weekly: 0, monthly: 0 } },
  cooldown: "1m",
  versions: 0,
  versionBytes: 0,
  filesystem: "nfs",
  capacity: 100,
  available: 50,
  activeUploads: 0,
  stagingBytes: 0,
});
const observed: Stats = {
  path: ".",
  started: "2026-09-19T12:00:00Z",
  completed: "2026-09-19T12:00:01Z",
  updated: "2026-09-19T12:00:01Z",
  complete: true,
  freshness: "observed",
  source: "filesystem",
  files: 5,
  directories: 2,
  bytes: 10,
};

test("missing or incomplete totals are unknown, not empty or misleading partial totals", () => {
  expect(rootSummary(root(null))).toMatchObject({ files: null, directories: null, bytes: null, observation: null });
  expect(rootSummary(root({ ...observed, complete: false }))).toMatchObject({
    files: null,
    directories: null,
    bytes: null,
    observation: { complete: false, freshness: "observed", source: "filesystem", started: observed.started, completed: observed.completed },
  });
});
test("unknown index freshness cannot be presented as filesystem totals", () => {
  expect(rootSummary(root({ ...observed, freshness: "unknown", source: "index", indexBuilt: "2026-09-18T12:00:00Z" }))).toMatchObject({
    files: null,
    directories: null,
    bytes: null,
    observation: { complete: true, freshness: "unknown", source: "index", indexBuilt: "2026-09-18T12:00:00Z" },
  });
});
test("complete observed scans preserve real zeroes and their observation interval", () => {
  expect(rootSummary(root(observed))).toMatchObject({ files: 5, directories: 2, bytes: 10 });
  expect(rootSummary(root({ ...observed, files: 0, directories: 0, bytes: 0 }))).toMatchObject({
    files: 0,
    directories: 0,
    bytes: 0,
    observation: { complete: true, freshness: "observed", source: "filesystem", started: observed.started, completed: observed.completed },
  });
});
