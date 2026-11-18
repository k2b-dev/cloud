import { expect, spyOn, test } from "bun:test";
import { emptyCodeOutput } from "../code/output";
import type { CodeRunEntries } from "../code/run-ledger";
import type { LiveSubscriptionHandlers } from "./live";
import * as transport from "./live";
import { followCodeRun } from "./code-runs";

const scope = { codeId: "c_fixture", runId: "11111111-1111-4111-8111-111111111111" };
const at = "2030-01-02T00:00:00.000Z";
const initial: CodeRunEntries = { state: "running", outcome: null, startedAt: at, endedAt: null, output: emptyCodeOutput(1) };
test("one run applies ordinary output without reads and covers gaps, reconnects and completion", async () => {
  let handlers: LiveSubscriptionHandlers<unknown> | undefined;
  let closed = 0;
  const spy = spyOn(transport, "liveConnection").mockImplementation(() => ({
    subscribe: (channel, selected, current) => {
      expect(channel).toBe("codeRun"); expect(selected).toEqual(scope);
      handlers = { ...current, parse: current.parse, apply: (events) => current.apply(events.map(({ data, cursor }) => ({ data: current.parse(data), cursor }))) };
      return { close: () => { closed++; } };
    },
  }));
  const snapshots: CodeRunEntries[] = [];
  let reads = 0;
  let authoritative = initial;
  const reasons: string[] = [];
  const stop = followCodeRun(scope, { initial,
    snapshot: async () => { reads++; return authoritative; }, apply: (data) => snapshots.push(data), unavailable: (reason) => reasons.push(reason),
  });
  const current = () => { if (!handlers) throw new Error("Missing subscription"); return handlers; };
  const output = (seq: number, runId = scope.runId) => ({ cursor: String(seq), data: { type: "code.output", runId, generation: 1, seq, entries: [], droppedLines: 0, droppedBytes: 0, budget: 32768 } });
  try {
    await current().apply([output(1)]);
    expect(reads).toBe(0); expect(snapshots.at(-1)?.output?.seq).toBe(1);
    await current().apply([output(1), output(2, "22222222-2222-4222-8222-222222222222")]);
    expect(reads).toBe(0); expect(snapshots).toHaveLength(1);
    authoritative = { ...initial, output: { ...emptyCodeOutput(1), seq: 3 } };
    await current().apply([output(3)]);
    expect(reads).toBe(1); expect(snapshots.at(-1)?.output?.seq).toBe(3);
    await current().resync(); expect(reads).toBe(2);
    current().caughtUp?.(true);
    await Promise.resolve();
    expect(reads).toBe(2);
    authoritative = { ...authoritative, state: "succeeded", endedAt: at };
    await current().apply([{ cursor: "4", data: { type: "code.run", runId: scope.runId, state: "succeeded", at } }]);
    expect(reads).toBe(3); expect(snapshots.at(-1)?.state).toBe("succeeded");
    await current().apply([{ cursor: "3", data: { type: "code.run", runId: scope.runId, state: "running", at } }]);
    expect(snapshots.at(-1)?.state).toBe("succeeded");
    current().revoked?.("access_denied");
    await current().resync(); await current().apply([output(4)]);
    expect(reads).toBe(3); expect(reasons).toEqual(["revoked"]);
  } finally { stop(); spy.mockRestore(); }
  expect(closed).toBeGreaterThan(0);
});

test("a failed covering read reports unavailable and disposal aborts work", async () => {
  const work: { signal?: AbortSignal } = {};
  const reasons: string[] = [];
  const spy = spyOn(transport, "liveConnection").mockImplementation(() => ({
    subscribe: (_channel, _scope, handlers) => {
      handlers.caughtUp?.(true);
      return { close: () => {} };
    },
  }));
  const stop = followCodeRun(scope, { initial, snapshot: async (current) => { work.signal = current; throw new Error("Unavailable"); }, apply: () => {}, unavailable: (reason) => reasons.push(reason) });
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(reasons).toEqual(["unavailable"]); expect(work.signal?.aborted).toBe(true);
  } finally { stop(); spy.mockRestore(); }
});
