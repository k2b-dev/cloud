import { expect, test } from "bun:test";
import { createBaseStore } from "./base-store";

test("prepared queries never reload settings while a SQL connection is reserved", async () => {
  let reserved = false,
    reads = 0;
  const store = createBaseStore({
    connection: async () => {
      if (reserved) throw new Error("Nested SQL reservation");
      reads++;
      return { url: "http://127.0.0.1:8123", user: "pulse_service", password: "fixture-password" };
    },
    transport: async () => Response.json({ data: [{ value: 1 }] }, { headers: { "X-ClickHouse-Query-Id": "fixture" } }),
  });
  const query = await store.prepare();
  reserved = true;
  expect(await query("SELECT 1 AS value")).toEqual([{ value: 1 }]);
  expect(await query("SELECT 1 AS value")).toEqual([{ value: 1 }]);
  expect(reads).toBe(1);
});

test("preparation preserves an injected query on a store replica", async () => {
  const store = createBaseStore({ connection: async () => null });
  const injected = { ...store, query: async () => [{ value: 42 }] };
  expect(await (await injected.prepare())("SELECT 1")).toEqual([{ value: 42 }]);
});
