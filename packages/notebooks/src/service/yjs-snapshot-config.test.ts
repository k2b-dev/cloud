import { expect, test } from "bun:test";
import { SNAPSHOT_JOB_CONFIG } from "./yjs-snapshot-worker";

test("Notebooks keeps the installed snapshot job declaration exactly without a broker", () => {
  expect(SNAPSHOT_JOB_CONFIG).toStrictEqual({
    id: "notebooks.yjs.snapshot.ordered",
    delivery: { ackWaitMs: 120000, maxAttempts: 20, backoffMs: [5000] },
    ordering: { mode: "partitioned", partitions: 8 },
    retention: { maxAgeMs: 604800000, maxBytes: 1073741824 },
    terminalRetentionMs: 2592000000,
    deadLetterRetention: { maxBytes: 34603008 },
    dedupeWindowMs: 86400000,
  });
});
