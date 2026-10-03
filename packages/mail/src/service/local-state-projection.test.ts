import { describe, expect, test } from "bun:test";
import { type LaterStateCommand, type LocalStateProjection, planLocalStateRollback } from "./local-state-projection";

const ref = "00000000-0000-4000-8000-000000000001";
const projection = (previousFlags: string[], projectedFlags: string[]): LocalStateProjection => ({
  remoteMessageRefId: ref,
  previousFlags,
  previousKeywords: [],
  projectedFlags,
  projectedKeywords: [],
});

/** Fails commands in the given order, the way the runtime settles them, and returns what the message shows after each. */
const failInOrder = (initial: string[], queue: { id: string; projection: LocalStateProjection }[], order: string[]) => {
  let flags = initial;
  const projections = new Map(queue.map((command) => [command.id, command.projection]));
  const settled = new Set<string>();
  const shown: string[][] = [];
  for (const id of order) {
    const index = queue.findIndex((command) => command.id === id);
    const later: LaterStateCommand[] = queue
      .slice(index + 1)
      .map((command) => ({ id: command.id, settled: settled.has(command.id), projection: projections.get(command.id)! }));
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
    { id: "read", projection: projection([], ["\\Seen"]) },
    { id: "flag", projection: projection(["\\Seen"], ["\\Flagged", "\\Seen"]) },
  ];

  test("two queued changes that both fail leave the message as the provider has it, in either order", () => {
    expect(failInOrder(["\\Flagged", "\\Seen"], readThenFlag, ["read", "flag"])).toEqual([["\\Flagged"], []]);
    expect(failInOrder(["\\Flagged", "\\Seen"], readThenFlag, ["flag", "read"])).toEqual([["\\Seen"], []]);
  });

  test("keeps showing a later queued change of the same flag, and hands it the provider state", () => {
    const readThenUnread = [
      { id: "read", projection: projection([], ["\\Seen"]) },
      { id: "unread", projection: projection(["\\Seen"], []) },
    ];
    // Read fails while Unread is still due: the message stays unread, and Unread no longer changes anything.
    expect(failInOrder([], readThenUnread, ["read", "unread"])).toEqual([[], []]);
    // Unread fails first: Read is still due, so the message shows read until Read fails too.
    expect(failInOrder([], readThenUnread, ["unread", "read"])).toEqual([["\\Seen"], []]);
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
    expect(plan).toMatchObject({ flags: ["\\seen"], keywords: ["Later"] });
  });
});
