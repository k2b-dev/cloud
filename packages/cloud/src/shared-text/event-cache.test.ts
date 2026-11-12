import { expect, test } from "bun:test";
import { createSharedTextEventCache } from "./event-cache";

const cursor = (n: number) => `s6t.cache.${n}`;
const entries = Array.from({ length: 8 }, (_, i) => ({
  cursor: cursor(i + 1),
  data: { kind: "sync" as const, payload: String(i + 1), originNodeId: "node", originPeerId: null },
}));
const fixture = (budget = 100_000) => {
  const calls: Array<[string | null, string]> = [];
  const cache = createSharedTextEventCache(async function* (_id, after, until) {
    calls.push([after, until]);
    const sequence = (c: string) => Number(c.split(".").at(-1));
    yield* entries.filter(
      (e) =>
        sequence(e.cursor) > (after === until ? sequence(until) - 1 : after ? sequence(after) : 0) && sequence(e.cursor) <= sequence(until),
    );
  }, budget);
  const read = async (after: string | null, until: string) => Array.fromAsync(cache.events("doc", after, until));
  return { cache, calls, read };
};

test("covered state and structural history share one replay, and later edits read only the uncovered tail", async () => {
  const f = fixture();
  expect(await f.read(cursor(0), cursor(3))).toEqual(entries.slice(0, 3));
  expect(await f.read(cursor(1), cursor(3))).toMatchObject(entries.slice(1, 3));
  expect(await f.read(cursor(2), cursor(5))).toMatchObject(entries.slice(2, 5));
  expect(await f.read(cursor(4), cursor(4))).toMatchObject(entries.slice(3, 4));
  expect(f.calls).toEqual([
    [cursor(0), cursor(3)],
    [cursor(3), cursor(5)],
  ]);
});

test("a locally published receipt is available without a new replay consumer", async () => {
  const f = fixture();
  await f.read(cursor(0), cursor(2));
  f.cache.remember("doc", cursor(2), entries[2]!);
  expect(await f.read(cursor(0), cursor(3))).toMatchObject(entries.slice(0, 3));
  expect(f.calls).toHaveLength(1);
});

test("eviction or a different document never pretends a gap is covered", async () => {
  const bytes = JSON.stringify(entries[0]).length * 2;
  const f = fixture(bytes * 2);
  await f.read(cursor(0), cursor(5));
  await f.read(cursor(3), cursor(5));
  expect(f.calls).toHaveLength(1);
  await f.read(cursor(0), cursor(5));
  expect(f.calls).toHaveLength(2);
  f.cache.remember("other", cursor(5), entries[5]!);
  await f.read(cursor(4), cursor(6));
  expect(f.calls.at(-1)).toEqual([cursor(4), cursor(6)]);
});
