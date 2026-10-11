import { expect, test } from "bun:test";
import { invalidateSpacesData, subscribeToSpacesDataInvalidation } from "./workspace-events";

test("subscribers share each event's identity and invalidateSpacesData waits for their asynchronous work", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
  const cleanups: (() => void)[] = [];
  try {
    const pending = Promise.withResolvers<void>();
    const shared = new WeakMap<object, Promise<void>>();
    let probeCount = 0;
    let reloads = 0;
    const subscribe = () =>
      subscribeToSpacesDataInvalidation(["view"], async (event) => {
        let probe = shared.get(event);
        if (!probe) {
          probeCount++;
          probe = pending.promise;
          shared.set(event, probe);
        }
        await probe;
        reloads++;
      });
    cleanups.push(subscribe(), subscribe());

    let covered = false;
    const completion = invalidateSpacesData(["view"], "cursor", "Item01").then(() => {
      covered = true;
    });
    await Promise.resolve();
    expect(probeCount).toBe(1);
    expect(reloads).toBe(0);
    expect(covered).toBe(false);
    pending.resolve();
    await completion;
    expect(reloads).toBe(2);
    expect(covered).toBe(true);

    // Identical item/cursor values in another event must get a fresh probe.
    await invalidateSpacesData(["view"], "cursor", "Item01");
    expect(probeCount).toBe(2);
    expect(reloads).toBe(4);
  } finally {
    for (const cleanup of cleanups) cleanup();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
