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

test("opening the panel refreshes usage, and new data swaps the ring in place", async () => {
  const dom = createDomTestHarness();
  const { default: Quota, createAssistantQuota } = await import("./AssistantQuota");
  const resetsAt = new Date(Date.now() + 3 * 3_600_000).toISOString();
  const load = spyOn(assistantApi, "quotas").mockResolvedValue({
    enabled: true,
    balances: [{ scope: "*", unlimited: false, usedPercent: 100, resetsAt }],
  });
  const dispose = render(() => {
    const state = createAssistantQuota({ enabled: true, balances: [{ scope: "*", unlimited: false, usedPercent: 40, resetsAt }] });
    return createComponent(Quota, {
      get snapshot() {
        return state.data();
      },
      model: "a",
      modelLabel: "Model A",
      get error() {
        return state.error();
      },
      onRefresh: state.refresh,
    });
  }, dom.root);
  try {
    await tick();
    const trigger = dom.root.querySelector<HTMLButtonElement>("button.k2b-chat-context")!;
    const popup = dom.root.querySelector<HTMLElement>("[role=dialog]")!;
    popup.showPopover = () => {};
    popup.hidePopover = () => {};
    expect(trigger.getAttribute("aria-label")).toBe("Usage: 40%");
    expect(popup.querySelector("button")).toBeNull();
    const before = load.mock.calls.length;
    trigger.click();
    await tick();
    expect(load.mock.calls.length).toBe(before + 1);
    expect(dom.root.querySelector("button.k2b-chat-context")).toBe(trigger);
    expect(trigger.getAttribute("aria-label")).toBe("Usage: 100%, used up");
    expect(trigger.querySelector(".k2b-progress-ring")?.getAttribute("data-tone")).toBe("danger");
    expect(popup.querySelector("time")?.getAttribute("title")).toBeTruthy();

    // A failed refresh replaces the ring with the dashed circle in the same trigger, not with an empty ring.
    load.mockRejectedValue(new Error("offline"));
    trigger.click();
    trigger.click();
    await tick();
    expect(dom.root.querySelector("button.k2b-chat-context")).toBe(trigger);
    expect(trigger.getAttribute("aria-label")).toBe("Usage: Not available");
    expect(trigger.querySelector(".k2b-progress-ring")).toBeNull();
    expect(trigger.querySelector(".ti-circle-dashed")).not.toBeNull();
    expect(popup.textContent).toContain("Usage could not be loaded.");
  } finally {
    dispose();
    load.mockRestore();
    dom.cleanup();
  }
});
