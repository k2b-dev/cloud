import { afterAll, beforeAll, expect, test } from "bun:test";
import { natsSuite } from "../../../../../scripts/fixtures/test-infra";
import { openSync, until } from "./harness";

const suite = natsSuite();

suite("mutex contract", () => {
  let fixture: Awaited<ReturnType<typeof openSync>>;

  beforeAll(async () => {
    fixture = await openSync("mutex");
  });
  afterAll(async () => {
    await fixture?.close();
  });

  test("one holder wins, the lease expires after its TTL and the fence increases", async () => {
    const mutex = fixture.sync.mutex({ id: "contract", ttlMs: 1_000, retry: { maxAttempts: 1 } });
    const first = await mutex.acquire({ resource: "shared" });
    if (!first) throw new Error("first holder did not acquire the lock");
    expect(await mutex.acquire({ resource: "shared" })).toBeNull();

    let second = null as Awaited<ReturnType<typeof mutex.acquire>>;
    await until(
      async () => {
        second = await mutex.acquire({ resource: "shared" });
        return second !== null;
      },
      4_000,
      "the lease to expire",
    );
    if (!second) throw new Error("lease did not expire");
    expect(second.fence).toBeGreaterThan(first.fence);
    expect(await mutex.release(first)).toBe(false);
    expect(await mutex.release(second)).toBe(true);
    const third = await mutex.acquire({ resource: "shared" });
    expect(third?.fence).toBeGreaterThan(second.fence);
    if (third) await mutex.release(third);
  });
});
