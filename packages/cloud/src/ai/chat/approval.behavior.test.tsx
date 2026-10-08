import { expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { AiTurnBlock } from "../protocol";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const domTest = isServer ? test.skip : test;

const request: Extract<AiTurnBlock, { kind: "tool" }> = {
  id: "approval",
  callId: "approval",
  kind: "tool",
  name: "contacts__action__send",
  status: "awaiting_approval",
  args: {},
  presentation: {
    kind: "capability",
    appId: "contacts",
    appName: "Contacts",
    appIcon: "ti ti-address-book",
    title: "Send card",
    capabilityKind: "action",
  },
  approval: { message: "Contacts: Send card", allowAlways: false },
};

domTest("an approval announces its progress and a failed decision to screen readers", async () => {
  const dom = createDomTestHarness();
  const { AiChatActionsProvider } = await import("./message-actions");
  const { AiTurnBlockView } = await import("./blocks");
  let fail!: (error: Error) => void;
  const dispose = render(
    () => (
      <AiChatActionsProvider actions={{ onApproval: () => new Promise<void>((_resolve, reject) => (fail = reject)) }}>
        <AiTurnBlockView turnId="turn" block={request} active />
      </AiChatActionsProvider>
    ),
    dom.root,
  );
  try {
    const status = dom.root.querySelector('[data-ai-approval-footer] [role="status"]')!;
    // The live region exists before anything happens, so its later text is announced.
    expect(status.textContent).toBe("");
    const approve = Array.from(dom.root.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Send card")!;
    approve.click();
    await tick();
    expect(dom.root.querySelector('[data-ai-approval-footer] [role="status"]')).toBe(status);
    expect(status.textContent).toBe("Submitting");

    fail(new Error("offline"));
    await tick();
    await tick();
    expect(status.textContent).toBe("");
    expect(dom.root.querySelector('[role="alert"]')?.textContent?.trim()).toBe("Could not submit. Try again.");
  } finally {
    dispose();
    dom.cleanup();
  }
});
