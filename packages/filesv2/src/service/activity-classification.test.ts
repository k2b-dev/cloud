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
  maintain: mutation("sharing.inbox_session"),
  provision: mutation(),
  archive: mutation(),
  retire: read,
  archives: read,
  restore: mutation(),
  adminList: read,
  adminDownload: read,
  adminVersions: read,
  adminDeleteVersion: mutation("lifecycle.admin_delete_version"),
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
  publicInboxUpload: mixed("sharing.inbox_session"),
  publicInboxLease: mixed("sharing.inbox_session"),
  publicInboxCommit: mixed("sharing.inbox_session"),
  publicInboxAbort: mutation("sharing.inbox_session"),
  reconcileInboxUploads: mutation("sharing.inbox_session"),
  adminUploadReservations: read,
  remove: mutation("files.ensure_trash", "trash.transfer"),
  trash: base(),
  trashEntry: base(),
  restoreTrash: mutation("trash.transfer"),
  bases: base(),
  baseNames: read,
  list: base(),
  search: base(),
  folder: base(),
  publiclyShared: base(),
  folderLocation: base(),
  mkdir: { kind: "mutation", coverage: "converted" },
  mkdirs: { kind: "mutation", coverage: "converted" },
  upload: mutation("files.upload_session"),
  uploadLease: mixed("files.upload_session"),
  commitUpload: mutation("files.upload_session"),
  abortUpload: mutation("files.upload_session"),
  rename: { kind: "mutation", coverage: "converted" },
  move: { kind: "mutation", coverage: "converted" },
  copy: { kind: "mutation", coverage: "converted" },
  bundle: base(),
  versions: base(),
  commentVersion: mutation("files.version_comment"),
  restoreVersion: mutation("files.version_restore"),
  restoreVersionAs: mutation("files.version_restore_copy"),
  deleteVersion: mutation("files.version_delete"),
  versionDownload: base(),
  editor: base(),
  templateSource: base(),
  createFromBytes: mutation("files.write_bytes"),
  createDocument: mutation("files.write_bytes"),
  editorFileInfo: base(),
  editorContent: base(),
  editorSave: mutation("files.write_bytes"),
  entry: base(),
  entryById: base(),
  recent: base(),
  favorites: base(),
  setFavorite: base(),
  thumbnail: base(),
  capabilityDownload: base(),
  capabilityUploadStatus: mixed("files.upload_session"),
  capabilityUpload: mutation("files.upload_session"),
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
  use: mutation("files.write_bytes"),
};
function unclassified(methods: readonly string[], table: Record<string, Classification>): string[] {
  return methods.filter((name) => !Object.hasOwn(table, name));
}
const frozen = [
  "files.upload_session",
  "files.write_bytes",
  "files.ensure_trash",
  "files.version_comment",
  "files.version_restore",
  "files.version_restore_copy",
  "files.version_delete",
  "trash.transfer",
  "sharing.inbox_session",
  "lifecycle.admin_delete_version",
] as const;
function addedKeys(keys: readonly string[]): string[] {
  return keys.filter((key) => !frozen.some((known) => known === key));
}
const frozenCallSites: Readonly<Record<string, number>> = {
  "files.upload_session": 3,
  "files.write_bytes": 1,
  "files.ensure_trash": 1,
  "files.version_comment": 1,
  "files.version_restore": 1,
  "files.version_restore_copy": 1,
  "files.version_delete": 1,
  "trash.transfer": 1,
  "sharing.inbox_session": 3,
  "lifecycle.admin_delete_version": 1,
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
  expect(grownCallSites({ ...frozenCallSites, "files.version_comment": 2 })).toEqual(["files.version_comment"]);
  expect(grownCallSites({ ...frozenCallSites, "fake.new_write": 1 })).toEqual(["fake.new_write"]);
  expect(grownCallSites({ ...frozenCallSites, "files.version_comment": 0 })).toEqual([]);
  expect(grownCallSites({})).toEqual([]);
});
