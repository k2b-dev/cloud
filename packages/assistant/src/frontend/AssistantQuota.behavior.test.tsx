import { expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import { assistantApi } from "../api/client";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
test("seeded refresh shows pending state, coalesces requests and cleans up focus listener", async () => {
  const dom = createDomTestHarness();
  const { createAssistantQuota } = await import("./AssistantQuota");
  let finish: ((value: { enabled: boolean; balances: [] }) => void) | undefined;
  const load = spyOn(assistantApi, "quotas").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let refresh = () => {};
  const dispose = render(() => {
    const state = createAssistantQuota({ enabled: false, balances: [] });
    refresh = state.refresh;
    return createComponent(() => <span>{state.refreshing() ? "refreshing" : "ready"}</span>, {});
  }, dom.root);
  try {
    await tick();
    const before = load.mock.calls.length;
    refresh();
    refresh();
    await tick();
    expect(load.mock.calls.length).toBe(before + 1);
    expect(dom.root.textContent).toBe("refreshing");
    finish?.({ enabled: true, balances: [] });
    await tick();
    expect(dom.root.textContent).toBe("ready");
    dispose();
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    await tick();
    expect(load.mock.calls.length).toBe(before + 1);
  } finally {
    dispose();
    load.mockRestore();
    dom.cleanup();
  }
});
