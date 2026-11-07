import { expect, test } from "bun:test";
import { createPgOutbox } from "./outbox";

test("rejects unsafe identifiers before any query", () => {
  const config = { name: "t", publish: async () => {}, reconcileIntervalMs: 1, orderBy: "id", sequence: "seq" } as const;
  expect(() => createPgOutbox({ ...config, table: "events.outbox; DROP TABLE x" })).toThrow(/Invalid outbox table/);
  expect(() => createPgOutbox({ ...config, table: "events.outbox", sequence: "seq desc" })).toThrow(/Invalid outbox sequence column/);
});

test("outbox declarations validate identifiers without accessing pre-start SQL", async () => {
  const outbox = createPgOutbox({
    name: "offline-declaration",
    table: "events.outbox",
    orderBy: "id",
    sequence: "seq",
    where: { kind: "live", app_id: "example" },
    reconcileIntervalMs: 1,
    publish: async () => {},
  });
  expect(typeof outbox.claim).toBe("function");
  await outbox.stop();
  expect(() =>
    createPgOutbox({
      name: "invalid-filter",
      table: "events.outbox",
      orderBy: "id",
      sequence: "seq",
      where: { "kind; DROP TABLE x": "live" },
      reconcileIntervalMs: 1,
      publish: async () => {},
    }),
  ).toThrow(/Invalid outbox filter column/);
});
