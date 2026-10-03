import { describe, expect, test } from "bun:test";
import {
  type LaterStateCommand,
  type LocalStateProjection,
  type ProviderStateChange,
  planLocalStateRollback,
} from "./local-state-projection";

const ref = "00000000-0000-4000-8000-000000000001";
const projection = (previousFlags: string[], projectedFlags: string[]): LocalStateProjection => ({
  remoteMessageRefId: ref,
  previousFlags,
  previousKeywords: [],
  projectedFlags,
  projectedKeywords: [],
});

const add = (...flags: string[]): ProviderStateChange => ({ addFlags: flags, removeFlags: [], addKeywords: [], removeKeywords: [] });
const remove = (...flags: string[]): ProviderStateChange => ({ addFlags: [], removeFlags: flags, addKeywords: [], removeKeywords: [] });

/** Fails commands in the given order, the way the runtime settles them, and returns what the message shows after each. */
const failInOrder = (initial: string[], queue: Omit<LaterStateCommand, "projection">[], order: string[]) => {
  // Each command was queued on what the commands before it showed.
  let flags = initial;
  const projections = new Map<string, LocalStateProjection>();
  for (const command of queue) {
    const projected = [...flags.filter((flag) => !command.change.removeFlags.includes(flag)), ...command.change.addFlags];
    const next = [...new Set(projected)].sort();
    projections.set(command.id, projection(flags, next));
    flags = next;
  }
  const settled = new Set<string>();
  const shown: string[][] = [];
  for (const id of order) {
    const index = queue.findIndex((command) => command.id === id);
    const later: LaterStateCommand[] = queue
      .slice(index + 1)
      .filter((command) => !settled.has(command.id))
      .map((command) => ({ ...command, projection: projections.get(command.id)! }));
    const plan = planLocalStateRollback({ failed: projections.get(id)!, current: { flags, keywords: [] }, later });
    for (const [laterId, next] of plan.laterProjections) projections.set(laterId, next);
    settled.add(id);
    flags = plan.flags;
    shown.push(flags);
  }
  return shown;
};

describe("planLocalStateRollback", () => {
  // Mark read, then Flag, both queued on an unread message: the second snapshot already shows the first.
  const readThenFlag = [
    { id: "read", change: add("\\Seen") },
    { id: "flag", change: add("\\Flagged") },
  ];

  test("two queued changes that both fail leave the message as the provider has it, in either order", () => {
    expect(failInOrder([], readThenFlag, ["read", "flag"])).toEqual([["\\Flagged"], []]);
    expect(failInOrder([], readThenFlag, ["flag", "read"])).toEqual([["\\Seen"], []]);
  });

  test("keeps showing a later queued change of the same flag, and hands it the provider state", () => {
    const readThenUnread = [
      { id: "read", change: add("\\Seen") },
      { id: "unread", change: remove("\\Seen") },
    ];
    // Read fails while Unread is still due: the message stays unread, and Unread no longer changes anything.
    expect(failInOrder([], readThenUnread, ["read", "unread"])).toEqual([[], []]);
    // Unread fails first: Read is still due, so the message shows read until Read fails too.
    expect(failInOrder([], readThenUnread, ["unread", "read"])).toEqual([["\\Seen"], []]);
  });

  test("keeps showing a later request for the same value, even when it changed nothing when it was queued", () => {
    const readTwice = [
      { id: "first", change: add("\\Seen") },
      { id: "again", change: add("\\Seen") },
    ];
    // The second Mark read is still due, so the message stays read until that one fails too.
    expect(failInOrder([], readTwice, ["first", "again"])).toEqual([["\\Seen"], []]);
    expect(failInOrder([], readTwice, ["again", "first"])).toEqual([["\\Seen"], []]);
  });

  test("leaves the message and later snapshots alone when the sync wrote between two queued changes", () => {
    // Mark read is queued, another client reads and answers the message, the sync writes that, then Flag is queued.
    const flag: LaterStateCommand = {
      id: "flag",
      change: add("\\Flagged"),
      projection: projection(["\\Answered", "\\Seen"], ["\\Answered", "\\Flagged", "\\Seen"]),
    };
    const readFails = planLocalStateRollback({
      failed: projection([], ["\\Seen"]),
      current: { flags: ["\\Answered", "\\Flagged", "\\Seen"], keywords: [] },
      later: [flag],
    });
    expect(readFails.flags).toEqual(["\\Answered", "\\Flagged", "\\Seen"]);
    expect(readFails.laterProjections.size).toBe(0);
    // Flag then fails too, and the message shows what the mail server has.
    const flagFails = planLocalStateRollback({ failed: flag.projection, current: { flags: readFails.flags, keywords: [] }, later: [] });
    expect(flagFails.flags).toEqual(["\\Answered", "\\Seen"]);
  });

  test("leaves the message alone once the sync wrote the provider's state over the queued changes", () => {
    const plan = planLocalStateRollback({
      failed: projection([], ["\\Seen"]),
      // Another client read and answered the message meanwhile, and the sync wrote that.
      current: { flags: ["\\Answered", "\\Seen"], keywords: [] },
      later: [],
    });
    expect(plan.flags).toEqual(["\\Answered", "\\Seen"]);
  });

  test("restores keywords the same way and compares values case-insensitively", () => {
    const plan = planLocalStateRollback({
      failed: { ...projection(["\\Seen"], ["\\Seen"]), previousKeywords: ["Later"], projectedKeywords: ["Done"] },
      current: { flags: ["\\seen"], keywords: ["done"] },
      later: [],
    });
    expect(plan).toMatchObject({ flags: ["\\Seen"], keywords: ["Later"] });
  });
});
