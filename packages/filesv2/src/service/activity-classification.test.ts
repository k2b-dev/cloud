import { expect, test } from "bun:test";
import { join } from "node:path";
import { PENDING_MIGRATION, PENDING_MIGRATION_METHODS, type PendingMigrationKey } from "./activity";
import { createFilesService } from "./index";
import { createTemplateService } from "./templates";

type Classification = { kind: "read" } | { kind: "mutation" | "mixed"; coverage: "converted" | readonly PendingMigrationKey[] };
const read: Classification = { kind: "read" };
const mixed = (...coverage: PendingMigrationKey[]): Classification => ({ kind: "mixed", coverage });
const mutation = (...coverage: PendingMigrationKey[]): Classification => ({ kind: "mutation", coverage });
const base = () => mixed("lifecycle.operation");
// This is the classification of Filegate user-data effects. Catalog/grant/configuration
// writes stay in Postgres; "read" here means they do not change data in Filegate.
const files: Record<string, Classification> = {
  maintain: mutation("lifecycle.operation"),
  provision: mutation("lifecycle.operation"),
  archive: mutation("lifecycle.operation"),
  retire: read,
  archives: read,
  restore: mutation("lifecycle.operation"),
  adminList: read,
  adminDownload: read,
  adminVersions: read,
  adminDeleteVersion: { kind: "mutation", coverage: "converted" },
  adminDelete: { kind: "mutation", coverage: "converted" },
  deleteDirectory: { kind: "mutation", coverage: "converted" },
  deleteArchive: { kind: "mutation", coverage: "converted" },
  retry: mutation("lifecycle.operation"),
  refreshRoot: read,
  rebuildRoot: read,
  unlockShare: base(),
  createShare: base(),
  listShares: read,
  revokeShare: read,
  publicShare: base(),
  publicShareDownload: base(),
  publicShareArchive: base(),
  publicInboxUpload: mixed("lifecycle.operation"),
  publicInboxLease: mixed("lifecycle.operation"),
  publicInboxCommit: mixed("lifecycle.operation"),
  publicInboxAbort: mutation("lifecycle.operation"),
  reconcileInboxUploads: mutation("lifecycle.operation"),
  adminUploadReservations: read,
  remove: mutation("lifecycle.operation"),
  trash: base(),
  trashEntry: base(),
  restoreTrash: mutation("lifecycle.operation"),
  bases: base(),
  baseNames: read,
  list: base(),
  search: base(),
  folder: base(),
  publiclyShared: base(),
  folderLocation: base(),
  mkdir: { kind: "mutation", coverage: "converted" },
  mkdirs: { kind: "mutation", coverage: "converted" },
  upload: mutation("lifecycle.operation"),
  uploadLease: mixed("lifecycle.operation"),
  commitUpload: mutation("lifecycle.operation"),
  abortUpload: mutation("lifecycle.operation"),
  rename: { kind: "mutation", coverage: "converted" },
  move: { kind: "mutation", coverage: "converted" },
  copy: { kind: "mutation", coverage: "converted" },
  bundle: base(),
  versions: base(),
  commentVersion: mutation("lifecycle.operation"),
  restoreVersion: mutation("lifecycle.operation"),
  restoreVersionAs: mutation("lifecycle.operation"),
  deleteVersion: mutation("lifecycle.operation"),
  versionDownload: base(),
  editor: base(),
  templateSource: base(),
  createFromBytes: mutation("lifecycle.operation"),
  createDocument: mutation("lifecycle.operation"),
  editorFileInfo: base(),
  editorContent: base(),
  editorSave: mutation("lifecycle.operation"),
  entry: base(),
  entryById: base(),
  recent: base(),
  favorites: base(),
  setFavorite: base(),
  thumbnail: base(),
  capabilityDownload: base(),
  capabilityUploadStatus: mixed("lifecycle.operation"),
  capabilityUpload: mutation("lifecycle.operation"),
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
  use: mutation("lifecycle.operation"),
};
function unclassified(methods: readonly string[], table: Record<string, Classification>): string[] {
  return methods.filter((name) => !Object.hasOwn(table, name));
}
const frozen = ["lifecycle.operation"] as const;
function addedKeys(keys: readonly string[]): string[] {
  return keys.filter((key) => !frozen.some((known) => known === key));
}
const frozenCallSites: Readonly<Record<string, number>> = {
  "lifecycle.operation": 1,
} satisfies Record<(typeof frozen)[number], number>;
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
test("pending migration methods cover exactly the migration keys and are non-empty", () => {
  expect(Object.keys(PENDING_MIGRATION_METHODS).sort()).toEqual([...PENDING_MIGRATION].sort());
  for (const methods of Object.values(PENDING_MIGRATION_METHODS)) expect(methods.length).toBeGreaterThan(0);
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
  expect(grownCallSites({ ...frozenCallSites, "files.upload_session": 0 })).toEqual([]);
  expect(grownCallSites({})).toEqual([]);
});
