import { describe, it, expect, mock, spyOn } from "bun:test";
import { testRoot } from "../_test-helpers";
import { clipboard } from "./clipboard";

// Mock navigator.clipboard
const writeTextMock = mock(() => Promise.resolve());
Object.defineProperty(globalThis, "navigator", {
  value: { clipboard: { writeText: writeTextMock } },
  writable: true,
  configurable: true,
});

describe("clipboard.create", () => {
  it("returns copy function and wasCopied signal", () => {
    const { result, dispose } = testRoot(() => clipboard.create());
    expect(typeof result.copy).toBe("function");
    expect(result.wasCopied()).toBe(false);
    dispose();
  });

  it("copy calls navigator.clipboard.writeText", async () => {
    writeTextMock.mockClear();
    const { result, dispose } = testRoot(() => clipboard.create());
    await result.copy("hello");
    expect(writeTextMock).toHaveBeenCalledWith("hello");
    dispose();
  });

  it("wasCopied becomes true after copy", async () => {
    const { result, dispose } = testRoot(() => clipboard.create());
    await result.copy("test");
    expect(result.wasCopied()).toBe(true);
    dispose();
  });

  it("wasCopied resets to false after timeout", async () => {
    const { result, dispose } = testRoot(() => clipboard.create(50));
    await result.copy("test");
    expect(result.wasCopied()).toBe(true);
    await Bun.sleep(80);
    expect(result.wasCopied()).toBe(false);
    dispose();
  });

  it("wasCopied stays false when writeText rejects", async () => {
    const failMock = mock(() => Promise.reject(new Error("denied")));
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { writeText: failMock } },
      writable: true,
      configurable: true,
    });

    // Suppress expected console.error from the catch block
    const origError = console.error;
    console.error = () => {};

    const { result, dispose } = testRoot(() => clipboard.create());
    await result.copy("nope");
    expect(result.wasCopied()).toBe(false);
    dispose();

    console.error = origError;

    // Restore working mock
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { writeText: writeTextMock } },
      writable: true,
      configurable: true,
    });
  });
});

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe("clipboard.createWriter", () => {
  it("sets and resets wasCopied after a successful write", async () => {
    const write = mock(async (_value: { id: string }) => {});
    const { result, dispose } = testRoot(() => clipboard.createWriter({ write, copiedFor: 30 }));

    expect(await result.copy({ id: "resource-1" })).toBe(true);
    expect(write).toHaveBeenCalledWith({ id: "resource-1" });
    expect(result.wasCopied()).toBe(true);
    expect(result.error()).toBeNull();

    await Bun.sleep(50);
    expect(result.wasCopied()).toBe(false);
    dispose();
  });

  it("restarts the feedback timer after another successful copy", async () => {
    const { result, dispose } = testRoot(() =>
      clipboard.createWriter({ write: async () => {}, copiedFor: 60 }),
    );

    await result.copy("first");
    await Bun.sleep(35);
    await result.copy("second");
    await Bun.sleep(35);
    expect(result.wasCopied()).toBe(true);

    await Bun.sleep(40);
    expect(result.wasCopied()).toBe(false);
    dispose();
  });

  it("reports a failed write without setting wasCopied", async () => {
    const failure = new Error("denied");
    const { result, dispose } = testRoot(() =>
      clipboard.createWriter({ write: async () => Promise.reject(failure) }),
    );

    expect(await result.copy("value")).toBe(false);
    expect(result.wasCopied()).toBe(false);
    expect(result.error()).toBe(failure);
    dispose();
  });

  it("clears the previous error when a new attempt starts", async () => {
    const pending = deferred();
    let attempt = 0;
    const { result, dispose } = testRoot(() =>
      clipboard.createWriter({
        write: async () => {
          if (attempt++ === 0) throw new Error("first failed");
          return pending.promise;
        },
      }),
    );

    await result.copy("first");
    const retry = result.copy("second");
    expect(result.error()).toBeNull();
    expect(result.wasCopied()).toBe(false);

    pending.resolve();
    expect(await retry).toBe(true);
    dispose();
  });

  it("ignores a late success from an older invocation", async () => {
    const older = deferred();
    const newerFailure = new Error("newer failed");
    const { result, dispose } = testRoot(() =>
      clipboard.createWriter({
        write: (value: string) =>
          value === "older" ? older.promise : Promise.reject(newerFailure),
      }),
    );

    const olderCopy = result.copy("older");
    expect(await result.copy("newer")).toBe(false);
    older.resolve();
    expect(await olderCopy).toBe(true);

    expect(result.wasCopied()).toBe(false);
    expect(result.error()).toBe(newerFailure);
    dispose();
  });

  it("ignores a late error from an older invocation", async () => {
    const older = deferred();
    const olderFailure = new Error("older failed");
    const { result, dispose } = testRoot(() =>
      clipboard.createWriter({
        write: (value: string) => (value === "older" ? older.promise : Promise.resolve()),
      }),
    );

    const olderCopy = result.copy("older");
    expect(await result.copy("newer")).toBe(true);
    older.reject(olderFailure);
    expect(await olderCopy).toBe(false);

    expect(result.wasCopied()).toBe(true);
    expect(result.error()).toBeNull();
    dispose();
  });

  it("clears a pending feedback timer when its owner is disposed", async () => {
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");
    const { result, dispose } = testRoot(() =>
      clipboard.createWriter({ write: async () => {}, copiedFor: 30 }),
    );

    await result.copy("value");
    expect(result.wasCopied()).toBe(true);
    clearTimeoutSpy.mockClear();
    dispose();

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    clearTimeoutSpy.mockRestore();
  });
});
