import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { encryptValue } from "./crypto";
import { deleteKey, orderGeoBudgetMutations, writeKey } from "./store";

const previousSecret = process.env.APP_SECRET;
beforeAll(() => {
  process.env.APP_SECRET = "test-only-geo-budget";
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.APP_SECRET;
  else process.env.APP_SECRET = previousSecret;
});
const month = "geo.monthly_budget_credits",
  day = "geo.person_daily_credits";
const transaction = (replies: { value?: string; key?: string }[][]) => {
  const queries: string[] = [],
    client = new SQL("postgres://localhost/unused_test");
  const db = new Proxy(client, {
    apply(_target, _receiver, args) {
      queries.push(args[0].join("?").replace(/\s+/g, " ").trim());
      const reply = replies.shift();
      if (!reply) throw new Error("Unexpected query");
      return Promise.resolve(reply);
    },
  });
  return { db, queries, close: () => client.close() };
};
test("ordinary writes and resets validate under the same transaction lock before mutation", async () => {
  for (const [key, value, reset, counterpart] of [
    [month, 299, false, 300],
    [day, 301, false, 300],
    [day, 0, true, 299],
    [month, 0, true, 90001],
  ] as const) {
    const tx = transaction([[], [{ value: await encryptValue(counterpart) }]]);
    try {
      await expect(reset ? deleteKey(key, tx.db) : writeKey(key, value, tx.db)).rejects.toMatchObject({
        code: "geo_budget_invalid",
        status: 400,
      });
      expect(tx.queries).toHaveLength(2);
      expect(tx.queries[0]).toContain("pg_advisory_xact_lock");
      expect(tx.queries.some((query) => /^(UPDATE|DELETE|INSERT)/.test(query))).toBeFalse();
    } finally {
      await tx.close();
    }
  }
});
test("valid writes and resets reach storage after validation", async () => {
  for (const reset of [false, true]) {
    const tx = transaction([[], [{ value: await encryptValue(90000) }], [], ...(reset ? [] : [[{ key: day }]])]);
    try {
      if (reset) await deleteKey(day, tx.db);
      else await writeKey(day, 500, tx.db);
      expect(tx.queries.at(-1)).toContain(reset ? "DELETE FROM" : "INSERT INTO");
    } finally {
      await tx.close();
    }
  }
});
test("bulk decreases save day first; increases save month first, including resets", async () => {
  for (const [current, updates, resets, expected] of [
    [90000, { [month]: 100, [day]: 50 }, [], [day, month]],
    [100, { [day]: 500, [month]: 1000 }, [], [month, day]],
    [100, {}, [day, month], [month, day]],
    [100000, {}, [month, day], [day, month]],
  ] as const) {
    const tx = transaction([[], [{ value: await encryptValue(current) }]]);
    try {
      expect(await orderGeoBudgetMutations(tx.db, updates, resets)).toEqual([...expected]);
    } finally {
      await tx.close();
    }
  }
});
