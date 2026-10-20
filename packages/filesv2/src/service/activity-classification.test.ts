import { expect, test } from "bun:test";
import { PENDING_MIGRATION, type PendingMigrationKey } from "./activity";
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
  maintain: mutation("lifecycle.operation", "sharing.inbox_session"),
  provision: mutation("lifecycle.operation"),
  archive: mutation("lifecycle.operation"),
  retire: read,
  archives: read,
  restore: mutation("lifecycle.operation"),
  adminList: read,
  adminDownload: read,
  adminVersions: read,
  adminDeleteVersion: mutation("lifecycle.admin_delete_version"),
  adminDelete: mutation("lifecycle.operation"),
  deleteDirectory: mutation("lifecycle.operation"),
  deleteArchive: mutation("lifecycle.operation"),
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
  publicInboxUpload: mixed("lifecycle.operation", "sharing.inbox_session"),
  publicInboxLease: mixed("lifecycle.operation", "sharing.inbox_session"),
  publicInboxCommit: mixed("lifecycle.operation", "sharing.inbox_session"),
  publicInboxAbort: mutation("lifecycle.operation", "sharing.inbox_session"),
  reconcileInboxUploads: mutation("lifecycle.operation", "sharing.inbox_session"),
  adminUploadReservations: read,
  remove: mutation("lifecycle.operation", "files.ensure_trash", "trash.transfer"),
  trash: base(),
  trashEntry: base(),
  restoreTrash: mutation("lifecycle.operation", "trash.transfer"),
  bases: base(),
  baseNames: read,
  list: base(),
  search: base(),
  folder: base(),
  publiclyShared: base(),
  folderLocation: base(),
  mkdir: { kind: "mutation", coverage: "converted" },
  mkdirs: { kind: "mutation", coverage: "converted" },
  upload: mutation("lifecycle.operation", "files.upload_session"),
  uploadLease: mixed("lifecycle.operation", "files.upload_session"),
  commitUpload: mutation("lifecycle.operation", "files.upload_session"),
  abortUpload: mutation("lifecycle.operation", "files.upload_session"),
  rename: mutation("lifecycle.operation", "files.rename"),
  move: mutation("lifecycle.operation", "files.move"),
  copy: mutation("lifecycle.operation", "files.copy"),
  bundle: base(),
  versions: base(),
  commentVersion: mutation("lifecycle.operation", "files.version_comment"),
  restoreVersion: mutation("lifecycle.operation", "files.version_restore"),
  restoreVersionAs: mutation("lifecycle.operation", "files.version_restore_copy"),
  deleteVersion: mutation("lifecycle.operation", "files.version_delete"),
  versionDownload: base(),
  editor: base(),
  templateSource: base(),
  createFromBytes: mutation("lifecycle.operation", "files.write_bytes"),
  createDocument: mutation("lifecycle.operation", "files.write_bytes"),
  editorFileInfo: base(),
  editorContent: base(),
  editorSave: mutation("lifecycle.operation", "files.write_bytes"),
  entry: base(),
  entryById: base(),
  recent: base(),
  favorites: base(),
  setFavorite: base(),
  thumbnail: base(),
  capabilityDownload: base(),
  capabilityUploadStatus: mixed("lifecycle.operation", "files.upload_session"),
  capabilityUpload: mutation("lifecycle.operation", "files.upload_session"),
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
  use: mutation("lifecycle.operation", "files.write_bytes"),
};
function unclassified(methods: readonly string[], table: Record<string, Classification>): string[] {
  return methods.filter((name) => !Object.hasOwn(table, name));
}
const frozen = [
  "files.upload_session",
  "files.write_bytes",
  "files.rename",
  "files.move",
  "files.copy",
  "files.ensure_trash",
  "files.version_comment",
  "files.version_restore",
  "files.version_restore_copy",
  "files.version_delete",
  "trash.transfer",
  "sharing.inbox_session",
  "lifecycle.operation",
  "lifecycle.admin_delete_version",
] as const;
function addedKeys(keys: readonly string[]): string[] {
  return keys.filter((key) => !frozen.some((known) => known === key));
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
