import { expect, spyOn, test } from "bun:test";
import { createDomTestHarness } from "../../../../ui/test/dom";

test("completion preloading shares one request, rejects a missing chunk, and can try again", async () => {
  const dom = createDomTestHarness();
  const reload = await import("../../browser/reload");
  const original = reload.importOnDemand;
  const pending = Promise.withResolvers<void>();
  let failed = true;
  let loads = 0;
  const loader = spyOn(reload, "importOnDemand").mockImplementation(async (load) => {
    loads++;
    await pending.promise;
    return failed ? undefined : original(load);
  });
  try {
    const { preloadAiChatDone } = await import("./chat-done-lazy");
    const first = preloadAiChatDone();
    expect(preloadAiChatDone()).toBe(first);
    expect(loads).toBe(1);
    pending.resolve();
    await expect(first).rejects.toThrow("Chat completion presentation could not load");
    failed = false;
    const second = preloadAiChatDone();
    expect(second).not.toBe(first);
    await second;
    expect(loads).toBe(2);
    expect(preloadAiChatDone()).toBe(second);
  } finally {
    loader.mockRestore();
    dom.cleanup();
  }
});
