import { expect, test } from "bun:test";
import { type JmapSyncState, readJmapSyncState, serializeJmapSyncState } from "./jmap-account-state";

const scan = {
  reason: "initial",
  startedAt: "2026-11-20T00:00:00.123Z",
  step: { kind: "query", before: null },
  pages: 0,
  restarts: 0,
  stalledAt: null,
} as const;

test("round-trips a strict checkpoint, preserving opaque states and uninitialized values", () => {
  const state = { version: 2, emailState: "state:/opaque value", mailboxState: "", scan: null } as const;
  expect(readJmapSyncState(serializeJmapSyncState(state))).toEqual(state);
  expect(serializeJmapSyncState({ ...state, emailState: null, mailboxState: null })).toEqual({
    version: 2,
    emailState: null,
    mailboxState: null,
    scan: null,
  });
  expect(readJmapSyncState(null)).toBeNull();
});

test("round-trips every scan step with its counters", () => {
  const steps: NonNullable<JmapSyncState["scan"]>["step"][] = [
    { kind: "query", before: "2026-11-19T10:00:08Z" },
    { kind: "bucket", second: "2026-11-19T10:00:08Z", position: 0, queryState: null },
    { kind: "bucket", second: "2026-11-19T10:00:08Z", position: 3, queryState: "q1" },
    { kind: "verify", afterEmailId: null },
    { kind: "verify", afterEmailId: "M123" },
  ];
  for (const step of steps) {
    const state: JmapSyncState = {
      version: 2,
      emailState: "Email:1",
      mailboxState: "Mailbox:1",
      scan: { ...scan, reason: "reconciliation", step, pages: 4, restarts: 2, stalledAt: "2026-11-20T00:15:00Z" },
    };
    expect(readJmapSyncState(serializeJmapSyncState(state)), step.kind).toEqual(state);
    for (const reason of ["initial", "repair"] as const) {
      const other = { ...state, scan: { ...scan, reason, step } };
      expect(readJmapSyncState(other), `${step.kind} ${reason}`).toEqual(other);
    }
  }
});

const full = { version: 2, emailState: "Email:0", mailboxState: "Mailbox:0" } as const;
for (const value of [
  undefined,
  [],
  "{}",
  1,
  { emailState: "old" },
  // Version 1 and every other version are unsupported; nothing upgrades them.
  { version: 1, emailState: null, mailboxState: null, scan: null },
  { version: 1, emailState: "Email:0", mailboxState: "Mailbox:0", scan: null },
  { version: 3, emailState: null, mailboxState: null, scan: null },
  { version: 2, emailState: null, mailboxState: null },
  { version: 2, emailState: null, mailboxState: null, scan: null, extra: true },
  { version: 2, emailState: "x".repeat(1_025), mailboxState: null, scan: null },
  // A running scan needs both states.
  { version: 2, emailState: null, mailboxState: "Mailbox:0", scan },
  { version: 2, emailState: "Email:0", mailboxState: null, scan },
  { ...full, scan: {} },
  { ...full, scan: { ...scan, extra: true } },
  { ...full, scan: { ...scan, reason: "rebuild" } },
  { ...full, scan: { ...scan, startedAt: "2026-11-20T01:00:00+01:00" } },
  { ...full, scan: { ...scan, startedAt: "yesterday" } },
  { ...full, scan: { ...scan, stalledAt: "2026-11-20" } },
  { ...full, scan: { ...scan, pages: -1 } },
  { ...full, scan: { ...scan, restarts: 1.5 } },
  { ...full, scan: { ...scan, pages: Number.MAX_SAFE_INTEGER + 1 } },
  { ...full, scan: { ...scan, step: { kind: "catchup" } } },
  { ...full, scan: { ...scan, step: { kind: "tail" } } },
  { ...full, scan: { ...scan, step: { kind: "query", before: "2026-11-19T10:00:08.5Z" } } },
  { ...full, scan: { ...scan, step: { kind: "bucket", second: "2026-11-19T10:00:08Z", position: 3, queryState: null } } },
  { ...full, scan: { ...scan, step: { kind: "verify", afterEmailId: "bad/id" } } },
]) {
  test(`rejects unsupported stored checkpoint shape ${JSON.stringify(value)?.slice(0, 120)}`, () => {
    expect(() => readJmapSyncState(value)).toThrow("JMAP_SYNC_STATE_UNSUPPORTED");
  });
}

test("serialization validates the checkpoint at runtime too", () => {
  expect(() => serializeJmapSyncState({ version: 2, emailState: "x".repeat(1_025), mailboxState: null, scan: null })).toThrow(
    "JMAP_SYNC_STATE_UNSUPPORTED",
  );
  expect(() => serializeJmapSyncState({ version: 2, emailState: null, mailboxState: "Mailbox:0", scan })).toThrow(
    "JMAP_SYNC_STATE_UNSUPPORTED",
  );
});
