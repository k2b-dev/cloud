import { expect, test } from "bun:test";
import { summarizeSyncFolderOutcome } from "./sync-runtime";

const idle = {
  hasMore: false,
  syncPending: false,
  imported: 0,
  uidValidityReset: false,
  draftImportsQueued: 0,
  draftExportsQueued: 0,
  flagsUpdated: 0,
  removed: 0,
};

test("folder sync omits a fully idle result", () => {
  expect(summarizeSyncFolderOutcome(idle)).toBeNull();
});

for (const effect of ["imported", "draftImportsQueued", "draftExportsQueued", "flagsUpdated", "removed"] as const) {
  test(`folder sync keeps ${effect}-only work`, () => {
    const result = { ...idle, [effect]: 1 };
    expect(summarizeSyncFolderOutcome(result)).toEqual(result);
  });
}

test("folder sync keeps continuation work", () => {
  const result = { ...idle, hasMore: true };
  expect(summarizeSyncFolderOutcome(result)).toEqual(result);
});

for (const deferred of ["SYNC_BUSY", "MAIL_RATE_LIMITED", "MAILBOX_TRANSPORT_CHANGED"]) {
  test(`folder sync omits routine ${deferred} deferral`, () => {
    expect(summarizeSyncFolderOutcome({ deferred })).toBeNull();
  });
}

test("folder sync keeps a rejected-data deferral visible", () => {
  const result = { deferred: "23514" };
  expect(summarizeSyncFolderOutcome(result)).toEqual(result);
});

test("folder sync keeps a UIDVALIDITY reset in an otherwise idle folder", () => {
  const result = { ...idle, uidValidityReset: true };
  expect(summarizeSyncFolderOutcome(result)).toEqual(result);
});
