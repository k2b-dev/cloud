import * as bunTest from "bun:test";

// Bun drops a timed-out callback's promise handler. Catching that promise from
// the side does not stop Bun reporting its late rejection between later tests.
// Keep the cancellation inside the callback boundary instead.
const native = { ...bunTest };
type Work = { finished: boolean; cancelled: boolean };
const pending = new Set<Work>();
let installed = false;

const endedByGuard = (error: unknown): error is Error => {
  if (!(error instanceof Error)) return false;
  const errno = "errno" in error ? error.errno : undefined;
  const code = "code" in error ? error.code : undefined;
  return [errno, code].some(
    (value) =>
      value === "57014" || value === "57P01" || value === "ERR_POSTGRES_CONNECTION_CLOSED" || value === "ERR_POSTGRES_EXPECTED_REQUEST",
  );
};

const observe = (callback: (...args: unknown[]) => unknown) => {
  const wrapped = function (this: unknown, ...args: unknown[]) {
    const work: Work = { finished: false, cancelled: false };
    const result = Reflect.apply(callback, this, args);
    if (!(result instanceof Promise)) return result;
    pending.add(work);
    return result
      .catch((error: unknown) => {
        // Only a callback already abandoned by the runner, followed by our
        // private-database cancellation, may consume the cancellation error.
        if (!work.cancelled || !endedByGuard(error)) throw error;
        console.warn("[test-infra] the guard ended a timed-out callback:", error.message);
      })
      .finally(() => pending.delete(work));
  };
  // Bun uses arity to distinguish done callbacks and parameterized tests.
  Object.defineProperty(wrapped, "length", { value: callback.length });
  return wrapped;
};

const registrations = new WeakMap<Function, Function>();
const originals = new WeakMap<object, Function>();
const registration = <T extends Function>(fn: T): T => {
  const cached = registrations.get(fn);
  if (cached) return cached as T;
  const wrapped = new Proxy(fn, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? registration(value) : value;
    },
    apply(target, receiver, args) {
      const result = Reflect.apply(
        target,
        originals.get(receiver) ?? receiver,
        args.map((value) => (typeof value === "function" ? observe(value) : value)),
      );
      // each/if/skipIf return another registration function; modifiers such
      // as only/skip are reached through get. Preserve their native receivers.
      return typeof result === "function" ? registration(result) : result;
    },
  });
  registrations.set(fn, wrapped);
  originals.set(wrapped, fn);
  return wrapped;
};

/** Install before files register callbacks; only owned databases enable cancellation. */
export const observeTestWork = (): void => {
  if (installed) return;
  installed = true;
  native.mock.module("bun:test", () => ({
    ...native,
    test: registration(native.test),
    it: registration(native.it),
    beforeEach: registration(native.beforeEach),
    afterEach: registration(native.afterEach),
  }));
};

/** Private-database suites run serially: at preload afterEach, pending callbacks timed out. */
export const finishTestWork = (): void => {
  for (const work of pending) work.finished = true;
};

/** Called before issuing cancellation, since the SQL rejection can arrive first. */
export const cancellingTestWork = (): void => {
  for (const work of pending) if (work.finished) work.cancelled = true;
};
