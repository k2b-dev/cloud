import { describe, expect, test } from "bun:test";
import { SignerRefreshes } from "./signer-refresh";

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("identity signer refresh single-flight", () => {
  test("coalesces concurrent refreshes for one purpose", async () => {
    const refreshes = new SignerRefreshes<string, string>();
    const pending = deferred<string>();
    let calls = 0;
    const refresh = () => {
      calls += 1;
      return pending.promise;
    };
    const commits: string[] = [];

    const first = refreshes.run("invocation", refresh, (value) => commits.push(value));
    const second = refreshes.run("invocation", refresh, (value) => commits.push(value));
    pending.resolve("signer-a");

    expect(await Promise.all([first, second])).toEqual(["signer-a", "signer-a"]);
    expect(calls).toBe(1);
    expect(commits).toEqual(["signer-a"]);
  });

  test("does not let invalidated work commit or satisfy later callers", async () => {
    const refreshes = new SignerRefreshes<string, string>();
    const stale = deferred<string>();
    const commits: string[] = [];
    const oldRefresh = refreshes.run(
      "invocation",
      () => stale.promise,
      (value) => commits.push(value),
    );

    refreshes.invalidate("invocation");
    const currentRefresh = refreshes.run(
      "invocation",
      async () => "signer-b",
      (value) => commits.push(value),
    );
    stale.resolve("signer-a");

    await expect(oldRefresh).rejects.toThrow("was invalidated");
    expect(await currentRefresh).toBe("signer-b");
    expect(commits).toEqual(["signer-b"]);
  });

  test("keeps independent purposes independent", async () => {
    const refreshes = new SignerRefreshes<string, string>();
    const invocation = deferred<string>();
    const session = deferred<string>();
    const commits: string[] = [];

    const invocationRefresh = refreshes.run(
      "invocation",
      () => invocation.promise,
      (value) => commits.push(value),
    );
    const sessionRefresh = refreshes.run(
      "session",
      () => session.promise,
      (value) => commits.push(value),
    );
    refreshes.invalidate("invocation");
    invocation.resolve("invocation-a");
    session.resolve("session-a");

    await expect(invocationRefresh).rejects.toThrow("was invalidated");
    expect(await sessionRefresh).toBe("session-a");
    expect(commits).toEqual(["session-a"]);
  });
});
