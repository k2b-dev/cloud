import { expect, spyOn, test } from "bun:test";
import type { LiveSubscriptionHandlers } from "../../browser/live";
import * as transport from "../../browser/live";
import { type CodeDetailEvent, type CodeDetailPositions, followCodeDetails } from "./code-live";

test("harden run positions to the active snapshot and clear them when observation ends", async () => {
  let handlers: Pick<LiveSubscriptionHandlers<unknown>, "apply" | "resync" | "unavailable"> | undefined;
  let closed = false;
  const spy = spyOn(transport, "liveConnection").mockImplementation(() => ({
    subscribe: (_channel, _scope, current) => {
      handlers = {
        apply: (events) => current.apply(events.map(({ data, cursor }) => ({ data: current.parse(data), cursor }))),
        resync: current.resync,
        unavailable: current.unavailable,
      };
      return {
        close: () => {
          closed = true;
        },
      };
    },
  }));
  const seen: CodeDetailEvent[] = [];
  const id = "11111111-1111-4111-8111-111111111111";
  let snapshot: CodeDetailPositions = { [id]: { generation: 1, seq: 0 } };
  const event = (runId: string, seq: number) => ({
    cursor: String(seq),
    data: {
      type: "code.output",
      runId,
      generation: 1,
      seq,
      entries: [],
      droppedLines: 0,
      droppedBytes: 0,
      budget: 32768,
    },
  });
  const stop = followCodeDetails(
    "c_fixture",
    (event) => seen.push(event),
    async () => snapshot,
    snapshot,
    () => {},
  );
  try {
    const current = () => {
      if (!handlers) throw new Error("Missing subscription");
      return handlers;
    };
    for (let index = 0; index < 1000; index++)
      await current().apply([event(`22222222-2222-4222-8222-${String(index).padStart(12, "0")}`, 1)]);
    expect(seen).toEqual([]);
    const future = event(id, 1);
    await current().apply([{ ...future, data: { ...future.data, entries: [{ kind: "future-kind", state: "done" }] } }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ entries: [{ kind: "future-kind", state: "done" }] });
    snapshot = {};
    await current().resync();
    await current().apply([event(id, 2)]);
    expect(seen).toHaveLength(1);
    snapshot = { [id]: { generation: 1, seq: 2 } };
    await current().resync();
    await current().apply([event(id, 3)]);
    expect(seen).toHaveLength(2);
    current().unavailable();
    await current().resync();
    await current().apply([event(id, 4)]);
    expect(seen).toHaveLength(2);
  } finally {
    stop();
    spy.mockRestore();
  }
  expect(closed).toBe(true);
});
