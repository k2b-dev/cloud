import { expect, test } from "bun:test";
import { createPgOutbox } from "./outbox";

test("rejects unsafe identifiers before any query", () => {
  const config = { name: "t", publish: async () => {}, reconcileIntervalMs: 1, orderBy: "id", sequence: "seq" } as const;
  expect(() => createPgOutbox({ ...config, table: "events.outbox; DROP TABLE x" })).toThrow(/Invalid outbox table/);
  expect(() => createPgOutbox({ ...config, table: "events.outbox", sequence: "seq desc" })).toThrow(/Invalid outbox sequence column/);
});
