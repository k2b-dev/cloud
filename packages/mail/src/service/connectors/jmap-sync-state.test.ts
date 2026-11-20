import { expect, test } from "bun:test";
import { readJmapSyncState, serializeJmapSyncState } from "./jmap-sync-state";

test("round-trips a strict checkpoint, preserving opaque states and uninitialized values", () => {
  const state = { version: 1, emailState: "state:/opaque value", mailboxState: "", scan: null } as const;
  expect(readJmapSyncState(serializeJmapSyncState(state))).toEqual(state);
  expect(serializeJmapSyncState({ ...state, emailState: null, mailboxState: null })).toEqual({
    version: 1,
    emailState: null,
    mailboxState: null,
    scan: null,
  });
  expect(readJmapSyncState(null)).toBeNull();
});

for (const value of [
  undefined,
  [],
  "{}",
  1,
  { emailState: "old" },
  { version: 2, emailState: null, mailboxState: null, scan: null },
  { version: 1, emailState: null, mailboxState: null, scan: {} },
  { version: 1, emailState: null, mailboxState: null, scan: null, extra: true },
  { version: 1, emailState: "x".repeat(1_025), mailboxState: null, scan: null },
]) {
  test(`rejects unsupported stored checkpoint shape ${typeof value}`, () => {
    expect(() => readJmapSyncState(value)).toThrow("JMAP_SYNC_STATE_UNSUPPORTED");
  });
}

test("serialization validates the checkpoint at runtime too", () => {
  expect(() => serializeJmapSyncState({ version: 1, emailState: "x".repeat(1_025), mailboxState: null, scan: null })).toThrow(
    "JMAP_SYNC_STATE_UNSUPPORTED",
  );
});
