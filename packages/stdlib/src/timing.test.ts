import { describe, it, expect, mock } from "bun:test";
import { withMinLoadTime, buffer, jitter, sleep, random, shuffle, debounce, throttle, timing } from "./timing";

// ==========================
// withMinLoadTime
// ==========================

describe("withMinLoadTime", () => {
  it("returns result of async function", async () => {
    const result = await withMinLoadTime(() => Promise.resolve(42), 0);
    expect(result).toBe(42);
  });

  it("delays if function is faster than minimum", async () => {
    const start = Date.now();
    await withMinLoadTime(() => Promise.resolve(1), 100);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(90);
  });

  it("does not add extra delay if function is slower than minimum", async () => {
    const start = Date.now();
    await withMinLoadTime(
      () => new Promise((r) => setTimeout(() => r(1), 100)),
      50,
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(180);
  });
});

// ==========================
// buffer (uses real timers with short delays)
// ==========================

describe("buffer", () => {
  it("calls flush function after interval for a key", async () => {
    const flush = mock(async (_key: string, _data: string) => {});
    const buffered = buffer(flush, 50);

    buffered("k1", "data1");
    await Bun.sleep(100);

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith("k1", "data1");
  });

  it("coalesces multiple writes to same key", async () => {
    const flush = mock(async (_key: string, _data: string) => {});
    const buffered = buffer(flush, 50);

    buffered("k1", "v1");
    buffered("k1", "v2");
    buffered("k1", "v3");
    await Bun.sleep(100);

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith("k1", "v3");
  });

  it("handles multiple keys independently", async () => {
    const flush = mock(async (_key: string, _data: string) => {});
    const buffered = buffer(flush, 50);

    buffered("k1", "v1");
    buffered("k2", "v2");
    await Bun.sleep(100);

    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("does not drop falsy payloads like 0 or empty string", async () => {
    const flush = mock(async (_key: string, _data: number) => {});
    const buffered = buffer(flush, 50);

    buffered("k1", 0);
    await Bun.sleep(100);

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith("k1", 0);
  });
});

// ==========================
// jitter
// ==========================

describe("jitter", () => {
  it("returns value within expected range", () => {
    for (let i = 0; i < 1000; i++) {
      const result = jitter(100, 10);
      expect(result).toBeGreaterThanOrEqual(90);
      expect(result).toBeLessThanOrEqual(110);
    }
  });

  it("returns base value when range is 0", () => {
    expect(jitter(100, 0)).toBe(100);
  });

  it("has approximate uniform distribution", () => {
    const samples = Array.from({ length: 1000 }, () => jitter(100, 10));
    const mean = samples.reduce((a, b) => a + b) / samples.length;
    expect(Math.abs(mean - 100)).toBeLessThan(2);
  });
});

// ==========================
// sleep
// ==========================

describe("sleep", () => {
  it("resolves after the specified delay", async () => {
    const start = Date.now();
    await sleep(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });

  it("resolves immediately for 0ms", async () => {
    const start = Date.now();
    await sleep(0);
    expect(Date.now() - start).toBeLessThan(20);
  });

  it("returns void (no value)", async () => {
    const result = await sleep(0);
    expect(result).toBeUndefined();
  });
});

// ==========================
// random
// ==========================

describe("random", () => {
  it("returns value in [0, 1) by default", () => {
    for (let i = 0; i < 500; i++) {
      const v = random();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("respects min and max range", () => {
    for (let i = 0; i < 500; i++) {
      const v = random(10, 20);
      expect(v).toBeGreaterThanOrEqual(10);
      expect(v).toBeLessThanOrEqual(20);
    }
  });

  it("rounds to step when provided", () => {
    for (let i = 0; i < 500; i++) {
      const v = random(0, 100, 5);
      expect(v % 5).toBe(0);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it("returns integers when step is 1", () => {
    for (let i = 0; i < 500; i++) {
      const v = random(1, 10, 1);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(10);
    }
  });

  it("has reasonable distribution", () => {
    const samples = Array.from({ length: 1000 }, () => random(0, 100));
    const mean = samples.reduce((a, b) => a + b) / samples.length;
    expect(mean).toBeGreaterThan(30);
    expect(mean).toBeLessThan(70);
  });
});

// ==========================
// shuffle
// ==========================

describe("shuffle", () => {
  it("returns array with same elements", () => {
    const input = [1, 2, 3, 4, 5];
    const result = shuffle(input);
    expect(result.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("does not mutate the original array", () => {
    const input = [1, 2, 3, 4, 5];
    const copy = [...input];
    shuffle(input);
    expect(input).toEqual(copy);
  });

  it("returns new array reference", () => {
    const input = [1, 2, 3];
    const result = shuffle(input);
    expect(result).not.toBe(input);
  });

  it("handles empty array", () => {
    expect(shuffle([])).toEqual([]);
  });

  it("handles single element", () => {
    expect(shuffle([42])).toEqual([42]);
  });

  it("actually shuffles (not always identity)", () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    let identityCount = 0;
    for (let i = 0; i < 50; i++) {
      const result = shuffle(input);
      if (result.every((v, j) => v === input[j])) identityCount++;
    }
    // Extremely unlikely to get identity more than a few times out of 50
    expect(identityCount).toBeLessThan(5);
  });
});

// ==========================
// debounce
// ==========================

describe("debounce", () => {
  it("delays execution", async () => {
    let count = 0;
    const d = timing.debounce(() => count++, 50);
    d.call(); d.call(); d.call();
    expect(count).toBe(0);
    await Bun.sleep(80);
    expect(count).toBe(1);
  });

  it("cancel prevents execution", async () => {
    let count = 0;
    const d = timing.debounce(() => count++, 50);
    d.call();
    d.cancel();
    await Bun.sleep(80);
    expect(count).toBe(0);
  });

  it("flush fires immediately", () => {
    let count = 0;
    const d = timing.debounce(() => count++, 1000);
    d.call();
    expect(d.isPending()).toBe(true);
    d.flush();
    expect(count).toBe(1);
    expect(d.isPending()).toBe(false);
  });

  it("uses latest args", async () => {
    let last = "";
    const d = timing.debounce((v: string) => { last = v; }, 50);
    d.call("a"); d.call("b"); d.call("c");
    await Bun.sleep(80);
    expect(last).toBe("c");
  });
});

// ==========================
// throttle
// ==========================

describe("throttle", () => {
  it("fires first call immediately", () => {
    let count = 0;
    const t = timing.throttle(() => count++, 100);
    t.call();
    expect(count).toBe(1);
  });

  it("drops calls within interval", () => {
    let count = 0;
    const t = timing.throttle(() => count++, 100);
    t.call(); t.call(); t.call();
    expect(count).toBe(1);
  });

  it("fires again after interval", async () => {
    let count = 0;
    const t = timing.throttle(() => count++, 50);
    t.call();
    expect(count).toBe(1);
    await Bun.sleep(80);
    t.call();
    expect(count).toBe(2);
  });

  it("cancel prevents trailing call", async () => {
    let count = 0;
    const t = timing.throttle(() => count++, 50);
    t.call(); // fires immediately
    t.call(); // schedules trailing
    t.cancel();
    await Bun.sleep(80);
    expect(count).toBe(1); // trailing was cancelled
  });
});

// ==========================
// buffer — race + undefined regression
// ==========================

describe("buffer (regression)", () => {
  it("preserves a write that arrives during an in-flight flush", async () => {
    const writes: Array<[string, number]> = [];
    let firstFlushResolve: (() => void) | null = null;
    const fn = mock(async (k: string, v: number) => {
      writes.push([k, v]);
      // First flush hangs until released so we can sneak in a second write.
      if (writes.length === 1) {
        await new Promise<void>((r) => (firstFlushResolve = r));
      }
    });
    const buffered = buffer<number>(fn, 10);
    buffered("k", 1);
    await Bun.sleep(20); // flush triggers, fn(k,1) starts but blocks
    buffered("k", 2); // arrives while flush in-flight; schedules new timer
    await Bun.sleep(5);
    firstFlushResolve!(); // release first flush
    await Bun.sleep(40); // second timer fires
    expect(writes).toEqual([
      ["k", 1],
      ["k", 2],
    ]);
  });

  it("does not deadlock on undefined values", async () => {
    const fn = mock(async () => {});
    const buffered = buffer<number | undefined>(fn, 10);
    buffered("k", undefined as unknown as number);
    await Bun.sleep(25);
    // Even though latest is undefined, the timer slot must be released so a
    // future write can register a new timer (was previously deadlocked).
    buffered("k", 42);
    await Bun.sleep(25);
    expect(fn).toHaveBeenCalled();
    // The most recent call should be (k, 42).
    const lastCall = (fn.mock.calls as unknown as [string, number][]).at(-1)!;
    expect(lastCall[1]).toBe(42);
  });
});
