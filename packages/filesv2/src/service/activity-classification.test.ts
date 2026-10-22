import { expect, test } from "bun:test";
import { join } from "node:path";
import { PENDING_MIGRATION, PENDING_MIGRATION_METHODS, type PendingMigrationKey } from "./activity";
import { createFilesService } from "./index";
import { createTemplateService } from "./templates";

type Classification = { kind: "read" } | { kind: "mutation" | "mixed"; coverage: "converted" | readonly PendingMigrationKey[] };
const read: Classification = { kind: "read" };
const mixed = (...coverage: PendingMigrationKey[]): Classification => ({
  kind: "mixed",
  coverage: coverage.length ? coverage : "converted",
});
const mutation = (...coverage: PendingMigrationKey[]): Classification => ({
  kind: "mutation",
  coverage: coverage.length ? coverage : "converted",
});
const base = () => mixed();
// This is the classification of Filegate user-data effects. Catalog/grant/configuration
// writes stay in Postgres; "read" here means they do not change data in Filegate.
const files: Record<string, Classification> = {
  maintain: mutation(),
  provision: mutation(),
  archive: mutation(),
  retire: read,
  archives: read,
  restore: mutation(),
  adminList: read,
  adminDownload: read,
  adminVersions: read,
  adminDeleteVersion: mutation(),
  adminDelete: mutation(),
  deleteDirectory: mutation(),
  deleteArchive: mutation(),
  retry: mutation(),
  refreshRoot: read,
  rebuildRoot: read,
  unlockShare: base(),
  createShare: base(),
  listShares: read,
  revokeShare: read,
  publicShare: base(),
  publicShareDownload: base(),
  publicShareArchive: base(),
  publicInboxUpload: mixed(),
  publicInboxLease: mixed(),
  publicInboxCommit: mixed(),
  publicInboxAbort: mutation(),
  reconcileInboxUploads: mutation(),
  adminUploadReservations: read,
  remove: mutation(),
  trash: base(),
  trashEntry: base(),
  restoreTrash: mutation(),
  bases: base(),
  baseNames: read,
  list: base(),
  search: base(),
  folder: base(),
  publiclyShared: base(),
  folderLocation: base(),
  mkdir: { kind: "mutation", coverage: "converted" },
  mkdirs: { kind: "mutation", coverage: "converted" },
  upload: mutation(),
  uploadLease: mixed(),
  commitUpload: mutation(),
  abortUpload: mutation(),
  rename: { kind: "mutation", coverage: "converted" },
  move: { kind: "mutation", coverage: "converted" },
  copy: { kind: "mutation", coverage: "converted" },
  bundle: base(),
  versions: base(),
  commentVersion: mutation(),
  restoreVersion: mutation(),
  restoreVersionAs: mutation(),
  deleteVersion: mutation(),
  versionDownload: base(),
  editor: base(),
  templateSource: base(),
  createFromBytes: mutation(),
  createDocument: mutation(),
  editorFileInfo: base(),
  editorContent: base(),
  editorSave: mutation(),
  entry: base(),
  entryById: base(),
  recent: base(),
  favorites: base(),
  setFavorite: base(),
  thumbnail: base(),
  capabilityDownload: base(),
  capabilityUploadStatus: mixed(),
  capabilityUpload: mutation(),
  download: base(),
  downloadById: base(),
  inlinePdf: base(),
  saveConfiguration: read,
  resetConfiguration: read,
  admin: read,
  adopt: read,
};
const templates: Record<string, Classification> = {
  list: read,
  get: read,
  upload: read,
  import: base(),
  update: read,
  replace: read,
  remove: read,
  grants: read,
  grant: read,
  revoke: read,
  use: mutation(),
};
function unclassified(methods: readonly string[], table: Record<string, Classification>): string[] {
  return methods.filter((name) => !Object.hasOwn(table, name));
}
const frozen: readonly string[] = [];
function addedKeys(keys: readonly string[]): string[] {
  return keys.filter((key) => !frozen.some((known) => known === key));
}
const frozenCallSites: Readonly<Record<string, number>> = {};
function grownCallSites(counts: Readonly<Record<string, number>>): string[] {
  return Object.entries(counts)
    .filter(([key, count]) => !Object.hasOwn(frozenCallSites, key) || count > (frozenCallSites[key] ?? 0))
    .map(([key]) => key);
}

function dummyService() {
  const unused = (): never => {
    throw new Error("Classification must not invoke a dependency");
  };
  return createFilesService({
    identities: { reconcile: unused, localLifecycle: unused, self: unused, groups: unused, inventory: unused },
    bindings: { find: unused, claim: unused, byId: unused, path: unused },
    displayNames: unused,
    readConfiguration: unused,
    writeConfiguration: unused,
    resetConfiguration: unused,
    publicOrigin: unused,
    userById: unused,
    transfer: Object.assign(unused, { preconnect: unused }),
    connect: unused,
  });
}

test("every public method declares its Filegate effects without invoking dependencies", () => {
  const service = dummyService();
  expect(unclassified(Object.keys(service), files)).toEqual([]);
  expect(unclassified(Object.keys(createTemplateService(service)), templates)).toEqual([]);
  for (const entry of [...Object.values(files), ...Object.values(templates)]) {
    if (entry.kind !== "read" && entry.coverage !== "converted") {
      expect(entry.coverage.length).toBeGreaterThan(0);
      for (const key of entry.coverage) expect(PENDING_MIGRATION).toContain(key);
    }
  }
});
test("an unclassified new method fails the check", () =>
  expect(unclassified([...Object.keys(dummyService()), "newWrite"], files)).toEqual(["newWrite"]));
test("the migration allowlist can only shrink", () => {
  expect(addedKeys(PENDING_MIGRATION)).toEqual([]);
  expect(addedKeys([...PENDING_MIGRATION, "fake.new_write"])).toEqual(["fake.new_write"]);
  expect(addedKeys(PENDING_MIGRATION.slice(1))).toEqual([]);
});
test("all writer migrations are complete", () => {
  expect(PENDING_MIGRATION).toEqual([]);
  expect(PENDING_MIGRATION_METHODS).toEqual({});
});
test("pending migration call sites can only shrink", async () => {
  const sourceRoot = join(import.meta.dir, "..");
  const counts: Record<string, number> = {};
  let calls = 0;
  for await (const path of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: sourceRoot, onlyFiles: true })) {
    if (/\.(?:test|spec)\.tsx?$/.test(path)) continue;
    const source = await Bun.file(join(sourceRoot, path)).text();
    // A computed key would hide a call site from the count below.
    calls += source.match(/\bpendingMigration\s*\(/g)?.length ?? 0;
    for (const match of source.matchAll(/\bpendingMigration\s*\(\s*["']([^"']+)["']/g)) {
      const key = match[1];
      if (key) counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  expect(grownCallSites(counts)).toEqual([]);
  expect(Object.values(counts).reduce((sum, count) => sum + count, 0)).toBe(calls);
});
test("call site comparison reports growth and unknown keys but permits shrinking", () => {
  expect(grownCallSites({ ...frozenCallSites, "files.upload_session": 4 })).toEqual(["files.upload_session"]);
  expect(grownCallSites({ ...frozenCallSites, "fake.new_write": 1 })).toEqual(["fake.new_write"]);
  expect(grownCallSites({})).toEqual([]);
});
