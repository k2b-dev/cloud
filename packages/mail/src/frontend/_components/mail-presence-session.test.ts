import { describe, expect, test } from "bun:test";
import { createMailPresenceSession } from "./mail-presence-session";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

describe("mail presence session", () => {
  test("keeps at most one heartbeat in flight", async () => {
    const pending = deferred<{ participants: string[] } | null>();
    let calls = 0;
    const snapshots: string[][] = [];
    const session = createMailPresenceSession({
      heartbeat: async () => {
        calls++;
        return pending.promise;
      },
      leave: async () => undefined,
      onSnapshot: (snapshot) => snapshots.push(snapshot.participants),
      requestTimeoutMs: 60_000,
    });

    const first = session.heartbeat();
    await session.heartbeat();
    expect(calls).toBe(1);

    pending.resolve({ participants: ["one"] });
    await first;
    expect(snapshots).toEqual([["one"]]);
    session.dispose();
  });

  test("aborts the active heartbeat and leaves exactly once on disposal", async () => {
    let heartbeatWasAborted = false;
    let leaveCalls = 0;
    const session = createMailPresenceSession({
      heartbeat: (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              heartbeatWasAborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
      leave: async () => {
        leaveCalls++;
      },
      onSnapshot: () => undefined,
      requestTimeoutMs: 60_000,
    });

    const active = session.heartbeat();
    session.dispose();
    session.dispose();
    await active;
    await Promise.resolve();

    expect(heartbeatWasAborted).toBeTrue();
    expect(leaveCalls).toBe(1);
  });

  test("releases the slot after a failed heartbeat", async () => {
    let calls = 0;
    const session = createMailPresenceSession({
      heartbeat: async () => {
        calls++;
        if (calls === 1) throw new Error("offline");
        return { participants: [] };
      },
      leave: async () => undefined,
      onSnapshot: () => undefined,
      requestTimeoutMs: 60_000,
    });

    await session.heartbeat();
    await session.heartbeat();
    expect(calls).toBe(2);
    session.dispose();
  });

  test("reports a failed or timed-out heartbeat, but not one ended by disposal", async () => {
    let failures = 0;
    let answer: "fail" | "empty" | "hang" = "fail";
    const session = createMailPresenceSession<{ participants: string[] }>({
      heartbeat: (signal) =>
        answer === "fail"
          ? Promise.reject(new Error("offline"))
          : answer === "empty"
            ? Promise.resolve(null)
            : new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
      leave: async () => undefined,
      onSnapshot: () => undefined,
      onFailure: () => failures++,
      requestTimeoutMs: 5,
    });
    await session.heartbeat();
    answer = "empty";
    await session.heartbeat();
    answer = "hang";
    await session.heartbeat();
    expect(failures).toBe(3);
    answer = "hang";
    const pending = session.heartbeat();
    session.dispose();
    await pending;
    expect(failures).toBe(3);
  });
});
