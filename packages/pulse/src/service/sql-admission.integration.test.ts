import { afterAll, expect, test } from "bun:test";
import { requireInfraUrl, suiteFor } from "../../../../scripts/fixtures/test-infra";
import { validateSqlInput } from "../sql-params";
import { createSqlAdmission, LEASE_MS, WAIT_MS } from "./sql-admission";

const suite = suiteFor("valkey");
suite("SQL admission is atomic across replicas", () => {
  const instances: ReturnType<typeof createSqlAdmission>[] = [];
  afterAll(() => {
    for (const instance of instances) instance.close();
  });
  const setup = () => {
    let now = Date.parse("2026-10-20T10:59:30.000Z");
    const namespace = `test:pulse:sql:${crypto.randomUUID()}`;
    const make = () => {
      const instance = createSqlAdmission({
        url: requireInfraUrl("valkey"),
        namespace,
        testOnly: {
          nowMs: () => now,
          poll: async () => {
            now += WAIT_MS;
          },
        },
      });
      instances.push(instance);
      return instance;
    };
    return {
      a: make(),
      b: make(),
      advance: (ms: number) => {
        now += ms;
      },
    };
  };
  const input = (baseId: string, runId: string, countQuota = true) => ({ baseId, runId, quota: 600, countQuota });
  test("one per base, three per Cloud, and 21st waiter is refused without quota", async () => {
    const { a, b } = setup();
    const held = [];
    try {
      held.push(await a.acquire(input("a", "a1")), await b.acquire(input("b", "b1")), await a.acquire(input("c", "c1")));
      expect((await b.check(input("a", "a2"))).state).toBe("WAIT");
      for (let i = 0; i < 19; i++) expect((await b.check(input(`wait${i}`, `w${i}`))).state).toBe("WAIT");
      expect((await a.check(input("overflow", "last"))).state).toBe("QUEUE_FULL");
      expect((await a.usage("overflow")).used).toBe(0);
      expect((await a.usage("a")).used).toBe(1);
    } finally {
      for (const lease of held) await lease.release();
    }
  });
  test("five seconds waiting is BUSY; expired leases free all slots", async () => {
    const { a, b, advance } = setup();
    const first = await a.acquire(input("a", "first"));
    try {
      await expect(b.acquire(input("a", "waiting"))).rejects.toMatchObject({ code: "BUSY", status: 503, details: { retryAfter: 5 } });
      expect((await b.usage("a")).used).toBe(1);
      advance(LEASE_MS);
      const second = await b.acquire(input("a", "second"));
      await first.release(); // releasing an expired id cannot free the new lease.
      expect((await a.check(input("a", "third"))).state).toBe("WAIT");
      await second.release();
    } finally {
      await first.release();
    }
  });
  test("quota uses a clock hour and server clock retry delay; reads for counts are free", async () => {
    const { a, b, advance } = setup();
    const first = await a.acquire({ ...input("a", "one"), quota: 1 });
    await first.release();
    await expect(b.acquire({ ...input("a", "two"), quota: 1 })).rejects.toMatchObject({
      code: "QUOTA",
      status: 429,
      details: { retryAfter: 30, resetAt: "2026-10-20T11:00:00.000Z" },
    });
    const count = await b.acquire({ ...input("a", "counts", false), quota: 1 });
    await count.release();
    expect((await b.usage("a")).used).toBe(1);
    expect(() => validateSqlInput("SELECT :missing")).toThrow();
    expect((await b.usage("a")).used).toBe(1);
    advance(30000);
    const next = await b.acquire({ ...input("a", "next"), quota: 1 });
    await next.release();
    expect((await b.usage("a")).used).toBe(1);
    expect((await b.usage("a")).resetAt).toBe("2026-10-20T12:00:00.000Z");
  });
  test.each([WAIT_MS, WAIT_MS + 2001])("an expired waiter cannot take a freed slot after %i ms", async (elapsed) => {
    const { a, b, advance } = setup();
    const held = await a.acquire(input("a", "held"));
    try {
      const waiting = await b.check(input("a", "waiting"));
      expect(waiting.state).toBe("WAIT");
      advance(elapsed);
      await held.release();
      const expired = await b.check(input("a", "waiting"), waiting.nowMs + WAIT_MS);
      expect(expired.state).toBe("BUSY");
      expect((await a.usage("a")).used).toBe(1);
      const next = await b.acquire(input("a", "next"));
      await next.release();
      expect((await a.usage("a")).used).toBe(2);
    } finally {
      await held.release();
    }
  });
  test("alerts take only unqueued free slots and never consume the question quota", async () => {
    const { a, b } = setup();
    const held = await a.acquire(input("a", "interactive"));
    try {
      await expect(b.acquire({ ...input("a", "alert", false), freeOnly: true })).rejects.toMatchObject({ code: "BUSY" });
      expect((await b.usage("a")).used).toBe(1);
      // Even with a free Cloud slot, an alert must not overtake a waiting interactive query.
      expect((await b.check(input("a", "waiter"))).state).toBe("WAIT");
      await expect(b.acquire({ ...input("other", "alert-other", false), freeOnly: true })).rejects.toMatchObject({ code: "BUSY" });
      await b.release("a", "waiter");
      const free = await b.acquire({ ...input("other", "alert-free", false), freeOnly: true });
      await free.release();
      expect((await b.usage("other")).used).toBe(0);
    } finally {
      await held.release();
      await b.release("a", "waiter");
    }
  });
  test("actor ownership and cancellation propagate between replicas", async () => {
    const { a, b } = setup();
    expect(await a.register("a", "run", "user:one")).toBe(true);
    expect(await b.register("a", "run", "user:two")).toBe(false);
    expect(await b.cancel("a", "run", "user:two")).toBe(false);
    expect(await b.cancel("a", "run", "user:one")).toBe(true);
    await expect(a.acquire(input("a", "run"))).rejects.toMatchObject({ code: "CANCELLED" });
    expect((await a.usage("a")).used).toBe(0);
    await a.forget("a", "run");
  });
});
