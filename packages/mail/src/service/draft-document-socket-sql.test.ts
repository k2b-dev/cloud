import { expect, test } from "bun:test";
import { awaitDraftDocumentQuery } from "./draft-document-socket-sql";

const queryFixture = () => {
  const pending = Promise.withResolvers<string>();
  let cancelled = 0;
  const query = Object.assign(pending.promise, {
    cancel() {
      cancelled++;
    },
  });
  return {
    ...pending,
    query,
    get cancelled() {
      return cancelled;
    },
  };
};

test("abort cancels the actual query and waits for it to settle", async () => {
  const controller = new AbortController();
  const fixture = queryFixture();
  let settled = false;
  const work = awaitDraftDocumentQuery(fixture.query, controller.signal);
  void work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  controller.abort();
  expect(fixture.cancelled).toBe(1);
  await Promise.resolve();
  expect(settled).toBe(false);
  const cancellation = new Error("Postgres confirmed query cancellation");
  fixture.reject(cancellation);
  await expect(work).rejects.toBe(cancellation);
  expect(settled).toBe(true);
});

test("an already-aborted signal cancels a lazy query before awaiting it", async () => {
  const controller = new AbortController();
  controller.abort();
  const fixture = queryFixture();
  const work = awaitDraftDocumentQuery(fixture.query, controller.signal);
  expect(fixture.cancelled).toBe(1);
  fixture.resolve("late result");
  await expect(work).rejects.toBe(controller.signal.reason);
});

test("abort at query completion cannot admit a late successful result", async () => {
  const controller = new AbortController();
  const fixture = queryFixture();
  const work = awaitDraftDocumentQuery(fixture.query, controller.signal);
  fixture.resolve("result");
  controller.abort();
  await expect(work).rejects.toBe(controller.signal.reason);
});

test("successful settlement removes the abort handler", async () => {
  const controller = new AbortController();
  const fixture = queryFixture();
  const work = awaitDraftDocumentQuery(fixture.query, controller.signal);
  fixture.resolve("result");
  await expect(work).resolves.toBe("result");
  controller.abort();
  expect(fixture.cancelled).toBe(0);
});

test("failed settlement preserves the query error and removes the abort handler", async () => {
  const controller = new AbortController();
  const fixture = queryFixture();
  const error = new Error("Query failed");
  const work = awaitDraftDocumentQuery(fixture.query, controller.signal);
  fixture.reject(error);
  await expect(work).rejects.toBe(error);
  controller.abort();
  expect(fixture.cancelled).toBe(0);
});
