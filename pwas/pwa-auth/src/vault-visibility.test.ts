import { expect, test } from "bun:test";
import { waitForVaultVisibility } from "./vault-visibility";

test("native-sheet completion waits for foreground and remains cancellable", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const page = Object.assign(new EventTarget(), { visibilityState: "hidden" });
  Object.defineProperty(globalThis, "document", { configurable: true, value: page });
  try {
    let settled = false;
    const pending = waitForVaultVisibility(new AbortController().signal).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    page.visibilityState = "visible";
    page.dispatchEvent(new Event("visibilitychange"));
    await pending;
    expect(settled).toBe(true);

    page.visibilityState = "hidden";
    const controller = new AbortController();
    const cancelled = waitForVaultVisibility(controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toThrow();
    page.visibilityState = "visible";
    page.dispatchEvent(new Event("visibilitychange"));
    expect(() => waitForVaultVisibility(controller.signal)).toThrow();
    await waitForVaultVisibility(new AbortController().signal);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "document", descriptor);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
