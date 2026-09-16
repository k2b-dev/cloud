import { describe, expect, mock, spyOn, test } from "bun:test";
import * as canonical from "../query-dsl/canonical";
import { bindDslQueryContext } from "../query-dsl/parameters";
import * as resolver from "../query-dsl/resolver";
import { amountFieldId, ctx, orders, parseOk } from "../query-dsl/resolver-fixtures";
import { createGqlPreparationCache, withPreparationCacheDeadline } from "./gql-preparation-cache";

const secret = "gql-preparation-cache-test-only";
const source = "from table Orders\nselect Amount\nwhere Amount > 1";
const fixture = () => {
  const entries = new Map<string, string>();
  const reads: string[] = [];
  const writes: string[] = [];
  const cache = createGqlPreparationCache(
    {
      get: async (key) => {
        reads.push(key);
        return entries.get(key) ?? null;
      },
      set: async (key, value) => {
        writes.push(key);
        entries.set(key, value);
      },
    },
    secret,
  );
  return { cache, entries, reads, writes };
};

describe("GQL preparation cache", () => {
  test("reuses serializable resolution and canonicalization, isolating request mutations", async () => {
    const { cache, reads, writes } = fixture();
    const resolve = spyOn(resolver, "resolveDslQueryToQueryPlan");
    const canonicalize = spyOn(canonical, "canonicalizeDslQuery");
    try {
      const first = await cache.resolve(parseOk(source), ctx());
      const second = await cache.resolve(parseOk(source), ctx());
      expect(second).toStrictEqual(first);
      expect(resolve).toHaveBeenCalledTimes(1);
      if (!second.ok) throw new Error("expected plan");
      second.plan.query.limit = 999;
      expect(await cache.resolve(parseOk(source), ctx())).toStrictEqual(first);
      const canonicalFirst = await cache.canonicalize(parseOk(source), ctx());
      expect(await cache.canonicalize(parseOk(source), ctx())).toEqual(canonicalFirst);
      expect(canonicalize).toHaveBeenCalledTimes(1);
      expect(writes).toHaveLength(2);
      expect(reads).toHaveLength(5);
      expect(writes.every((key) => /^grids:gql-preparation:v1:\d+$/.test(key))).toBe(true);
    } finally {
      resolve.mockRestore();
      canonicalize.mockRestore();
    }
  });

  test("round-trips computed, joined, grouped and predicate plans without shape changes", async () => {
    const { cache } = fixture();
    const queries = [
      "from table Orders\nselect formula(Amount + Cost) as total\nwhere Amount > Cost",
      "from table Orders as o\nleft join table Customers as c on o.customer_link = c.id\nselect o.Amount, c.Name",
      "from table Orders\ngroup by Status\naggregate sum(Amount) as total",
      "from table Orders\nwhere (Amount > 1 or Paid = true) and Cost < 10",
    ];
    for (const query of queries) {
      const ast = parseOk(query);
      const first = await cache.canonicalize(ast, ctx());
      expect(first.ok, query).toBe(true);
      expect(await cache.canonicalize(ast, ctx())).toStrictEqual(first);
    }
  });

  test("schema, current source, visible tables/views and document access participate in identity", async () => {
    const { cache, writes } = fixture();
    const ast = parseOk(source);
    const context = ctx();
    await cache.resolve(ast, context);
    const changedField = structuredClone(context);
    changedField.fieldsByTableId[orders.id]!.find((field) => field.id === amountFieldId)!.config = { decimalPlaces: 2 };
    await cache.resolve(ast, changedField);
    await cache.resolve(ast, { ...context, documentMetadata: true });
    await cache.resolve(ast, { ...context, currentTable: undefined });
    await cache.resolve(ast, { ...context, views: undefined });
    expect(writes).toHaveLength(5);
    const denied = await cache.resolve(ast, { ...context, tables: [], fieldsByTableId: {} });
    expect(denied.ok).toBe(false);
    expect(writes).toHaveLength(5);
  });

  test("binds request values before caching and never freezes time expressions", async () => {
    const { cache, writes } = fixture();
    const ast = parseOk("from table Orders\nwhere Amount > @params.minimum");
    const one = bindDslQueryContext(ast, { "params.minimum": 1 });
    const two = bindDslQueryContext(ast, { "params.minimum": 2 });
    if (!one.ok || !two.ok) throw new Error("expected bindings");
    const first = await cache.resolve(one.ast, ctx());
    const second = await cache.resolve(two.ast, ctx());
    expect(second).not.toEqual(first);
    expect(await cache.resolve(one.ast, ctx())).toEqual(first);
    expect(writes).toHaveLength(2);
    const timeAst = parseOk("from table Orders\nselect formula(NOW()) as current_time");
    const prepared = await cache.resolve(timeAst, ctx());
    expect(prepared.ok).toBe(true);
    expect(JSON.stringify(prepared)).toContain("NOW()");
    expect(await cache.resolve(timeAst, ctx())).toEqual(prepared);
  });

  test("keeps search text in the plan, never record matches or execution data", async () => {
    const { cache } = fixture();
    const prepared = await cache.resolve(parseOk("from table Orders\nsearch 'Alice' in Customer"), ctx());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error("expected plan");
    expect(prepared.plan.query.search?.q).toBe("Alice");
    expect(prepared.plan.query.search).not.toHaveProperty("recordIds");
    expect(await cache.resolve(parseOk("from table Orders\nsearch 'Bob' in Customer"), ctx())).not.toEqual(prepared);
  });

  test("corrupt, unsigned, mismatched and oversized entries recompile", async () => {
    const { cache, entries, writes } = fixture();
    const ast = parseOk(source);
    const first = await cache.resolve(ast, ctx());
    const key = writes[0]!;
    const valid = entries.get(key)!;
    const corruptions = [
      "not json",
      JSON.stringify({ fingerprint: "wrong", payload: "{}", signature: "00" }),
      valid.replace('"signature":"', '"signature":"00'),
      valid.replace('"payload":"', '"payload":" '),
      " ".repeat(64 * 1024 + 1),
    ];
    for (const corrupted of corruptions) {
      entries.set(key, corrupted);
      expect(await cache.resolve(ast, ctx())).toEqual(first);
      expect(entries.get(key)).toBe(valid);
    }
    expect(writes).toHaveLength(corruptions.length + 1);
  });

  test("cache outage and missing signing key preserve authoritative compilation", async () => {
    const unavailable = createGqlPreparationCache(
      {
        get: async () => {
          throw new Error("offline");
        },
        set: async () => {
          throw new Error("offline");
        },
      },
      secret,
    );
    const ast = parseOk(source);
    expect(await unavailable.resolve(ast, ctx())).toEqual(resolver.resolveDslQueryToQueryPlan(ast, ctx()));
    const withoutSecret = createGqlPreparationCache(
      {
        get: async () => {
          throw new Error("must not read");
        },
        set: async () => {
          throw new Error("must not write");
        },
      },
      "",
    );
    expect(await withoutSecret.resolve(ast, ctx())).toEqual(resolver.resolveDslQueryToQueryPlan(ast, ctx()));
  });

  test("bounds entry count regardless of request value cardinality", async () => {
    const { cache, entries } = fixture();
    for (let minimum = 0; minimum < 300; minimum++) {
      await cache.resolve(parseOk(`from table Orders\nwhere Amount > ${minimum}`), ctx());
    }
    expect(entries.size).toBeLessThanOrEqual(256);
    expect([...entries.values()].every((entry) => Buffer.byteLength(entry) <= 64 * 1024)).toBe(true);
  });

  test("compiler generations and signing-key changes cannot reuse old entries", async () => {
    const { cache, entries, writes } = fixture();
    const ast = parseOk(source);
    const first = await cache.resolve(ast, ctx());
    const key = writes[0]!;
    const value = entries.get(key)!;
    entries.clear();
    entries.set(key.replace(":v1:", ":v0:"), value);
    expect(await cache.resolve(ast, ctx())).toEqual(first);
    expect(writes).toHaveLength(2);
    let fills = 0;
    const rotated = createGqlPreparationCache(
      {
        get: async (key) => entries.get(key) ?? null,
        set: async () => {
          fills++;
        },
      },
      "different-test-secret",
    );
    expect(await rotated.resolve(ast, ctx())).toEqual(first);
    expect(fills).toBe(1);
  });

  test("connected but stalled cache commands are bounded and close their connection", async () => {
    const close = mock(() => {});
    await expect(withPreparationCacheDeadline({ close }, () => new Promise<never>(() => {}))).rejects.toThrow(
      "GQL preparation cache deadline",
    );
    expect(close).toHaveBeenCalledTimes(1);
    const alreadyClosed = mock(() => {
      throw new Error("already closed");
    });
    await expect(withPreparationCacheDeadline({ close: alreadyClosed }, () => new Promise<never>(() => {}))).rejects.toThrow(
      "GQL preparation cache deadline",
    );
    const healthyClose = mock(() => {});
    expect(await withPreparationCacheDeadline({ close: healthyClose }, async () => "cached")).toBe("cached");
    expect(healthyClose).not.toHaveBeenCalled();
  });

  test("a slow cache fill does not delay a successful compilation", async () => {
    const cache = createGqlPreparationCache(
      {
        get: async () => null,
        set: async () => new Promise<never>(() => {}),
      },
      secret,
    );
    expect((await cache.resolve(parseOk(source), ctx())).ok).toBe(true);
  });
});
