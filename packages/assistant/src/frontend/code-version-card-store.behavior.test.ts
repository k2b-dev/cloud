import { expect, spyOn, test } from "bun:test";
import { createRoot } from "solid-js";
import { isServer } from "solid-js/web";
import * as cards from "../code-version-cards";
import { createAssistantLiveHub } from "./assistant-live";
import { createCodeVersionCardStore } from "./code-version-card-store";

test("an unexpected loader failure keeps recovery visible and logs no private exception text", async () => {
  const ref = { codeId: "c_info01", versionId: "66666666-6666-4666-8666-666666666666" };
  const loader = spyOn(cards, "loadCodeVersionCards").mockRejectedValue(new Error("private-loader-detail"));
  const diagnostic = spyOn(console, "warn").mockImplementation(() => {});
  let dispose = () => {};
  try {
    const store = createRoot((cleanup) => {
      dispose = cleanup;
      const store = createCodeVersionCardStore(createAssistantLiveHub());
      store.retain(ref);
      return store;
    });
    expect(await store.refresh(ref)).toBe(false);
    expect(store.read(ref)).toBe("failed");
    expect(diagnostic).toHaveBeenCalledWith("Code version cards could not be loaded", { reason: "loader_failed" });
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("private-loader-detail");
  } finally {
    dispose();
    diagnostic.mockRestore();
    loader.mockRestore();
  }
});

test("a failed SSR snapshot retries once on browser mount, without a retain loop", async () => {
  expect(isServer).toBe(false);
  const ref = { codeId: "c_info01", versionId: "66666666-6666-4666-8666-666666666666" };
  let notify = () => {};
  const called = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const loader = spyOn(cards, "loadCodeVersionCards").mockImplementation(async () => {
    notify();
    return [{ ...ref, state: "failed" }];
  });
  let dispose = () => {};
  try {
    const store = createRoot((cleanup) => {
      dispose = cleanup;
      const store = createCodeVersionCardStore(createAssistantLiveHub(), [{ ...ref, state: "failed" }]);
      store.retain(ref);
      store.retain(ref);
      return store;
    });
    await called;
    await Promise.resolve();
    expect(loader).toHaveBeenCalledTimes(1);
    store.retain(ref);
    await Promise.resolve();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(store.read(ref)).toBe("failed");
  } finally {
    dispose();
    loader.mockRestore();
  }
});
