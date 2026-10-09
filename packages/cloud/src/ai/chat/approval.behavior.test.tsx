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

const runCode: Extract<AiTurnBlock, { kind: "tool" }> = {
  id: "tool-run",
  callId: "run",
  kind: "tool",
  name: "code_run",
  status: "awaiting_approval",
  args: { path: "report.ts" },
  approval: { message: "Run report.ts", allowAlways: false },
};

const mountTurn = async (initial: AiTurnBlock[], options: { locale?: string; phase?: "running" | "waiting" | "stopped" } = {}) => {
  const dom = createDomTestHarness();
  const { createSignal } = await import("solid-js");
  const { LocaleProvider } = await import("@k2b/ui");
  const { AiChatActionsProvider } = await import("./message-actions");
  const { AiTurnView } = await import("./turn-view");
  const { layoutAiTurn } = await import("./turn-layout");
  const { createAiToolDisclosureState } = await import("./tool-disclosure");
  const [blocks, setBlocks] = createSignal(initial);
  const [phase, setPhase] = createSignal<"running" | "waiting" | "stopped">(options.phase ?? "waiting");
  const decisions: unknown[] = [];
  const dispose = render(
    () => (
      <LocaleProvider locale={options.locale ?? "en"}>
        <AiChatActionsProvider actions={{ onApproval: async (_request, input) => void decisions.push(input) }}>
          <AiTurnView
            segment={() => ({
              id: "ai-turn:turn:start",
              turnId: "turn",
              phase: phase(),
              layout: layoutAiTurn(blocks(), { phase: phase() }),
              earlier: false,
              duration: () => null,
            })}
            disclosureState={createAiToolDisclosureState()}
          />
        </AiChatActionsProvider>
      </LocaleProvider>
    ),
    dom.root,
  );
  const button = (label: string) => Array.from(dom.root.querySelectorAll("button")).find((node) => node.textContent?.trim() === label)!;
  const place = () => dom.root.querySelector<HTMLElement>(".ai-turn__action")!;
  return {
    dom,
    decisions,
    setBlocks,
    setPhase,
    button,
    place,
    cleanup: () => {
      dispose();
      dom.cleanup();
    },
  };
};

domTest("a decided approval becomes a one-line receipt in its place at once, and focus stays there", async () => {
  const view = await mountTurn([runCode]);
  try {
    const place = view.place();
    expect(place.querySelector(".ai-approval")?.textContent).toContain("Runs only after you approve it");
    const approve = view.button("Run code");
    approve.focus();
    approve.click();
    await tick();
    await tick();
    expect(view.decisions).toEqual([{ approved: true }]);
    // The server has not reported the decision yet; the card already is its receipt, named for what runs.
    expect(view.place()).toBe(place);
    expect(place.querySelector(".ai-approval")).toBeNull();
    const receipt = place.querySelector<HTMLElement>(".ai-turn-receipt")!;
    expect(receipt.textContent).toBe("Running: Run code · report.ts");
    expect(document.activeElement).toBe(place);

    // The turn reports the decision and then the outcome: the same row changes only its words.
    view.setBlocks([{ ...runCode, status: "running", approved: true, approval: undefined }]);
    view.setPhase("running");
    expect(place.querySelector(".ai-turn-receipt")).toBe(receipt);
    view.setBlocks([{ ...runCode, status: "completed", approved: true, approval: undefined, result: { status: "ok" } }]);
    expect(place.querySelector(".ai-turn-receipt")).toBe(receipt);
    expect(receipt.textContent).toBe("Approved: Run code · report.ts");
    expect(receipt.textContent).not.toContain("code_run");
  } finally {
    view.cleanup();
  }
});

domTest("a rejected approval and one a stop left open read as receipts in the reader's language", async () => {
  const view = await mountTurn([runCode], { locale: "de" });
  try {
    view.button("Ablehnen").click();
    await tick();
    await tick();
    expect(view.decisions).toEqual([{ approved: false }]);
    const receipt = view.place().querySelector<HTMLElement>(".ai-turn-receipt")!;
    expect(receipt.textContent).toBe("Abgelehnt: Code ausführen · report.ts");
    view.setBlocks([{ ...runCode, status: "rejected", approval: undefined }]);
    expect(view.place().querySelector(".ai-turn-receipt")).toBe(receipt);
    expect(receipt.textContent).toBe("Abgelehnt: Code ausführen · report.ts");
  } finally {
    view.cleanup();
  }

  const stopped = await mountTurn([{ ...runCode, status: "running", approved: true, approval: undefined }], {
    locale: "de",
    phase: "stopped",
  });
  try {
    expect(stopped.place().textContent).toBe("Nicht ausgeführt: Code ausführen · report.ts · gestoppt");
  } finally {
    stopped.cleanup();
  }
});

domTest("a built-in tool's approval a stop left undecided becomes a quiet receipt where its card stood", async () => {
  const view = await mountTurn([runCode], { locale: "de" });
  try {
    const place = view.place();
    expect(place.querySelector(".ai-approval")).not.toBeNull();
    // History records the approval as expired; the call is no Cloud action, and still keeps its place.
    view.setBlocks([{ ...runCode, status: "running", approved: false, approval: undefined }]);
    view.setPhase("stopped");
    expect(view.place()).toBe(place);
    expect(place.textContent).toBe("Nicht ausgeführt: Code ausführen · report.ts · gestoppt");
    expect(place.querySelector(".ti-circle-off")).not.toBeNull();
  } finally {
    view.cleanup();
  }
});

domTest("an approval a stop left undecided becomes a quiet receipt where its card stood", async () => {
  const send: Extract<AiTurnBlock, { kind: "tool" }> = {
    ...request,
    presentation: { ...request.presentation!, appName: "Mail", title: "E-Mail senden" },
    args: { to: "Tom Weber" },
  };
  const view = await mountTurn([send], { locale: "de" });
  try {
    const place = view.place();
    expect(place.querySelector(".ai-approval")).not.toBeNull();
    // History rebuilds the call without its approval; the stopped turn reports it as not run, in the same place.
    view.setBlocks([{ ...send, status: "running", approval: undefined }]);
    view.setPhase("stopped");
    expect(view.place()).toBe(place);
    expect(place.querySelector(".ai-approval")).toBeNull();
    expect(place.textContent).toBe("Nicht ausgeführt: E-Mail senden · gestoppt");
    expect(place.querySelector(".ti-circle-off")).not.toBeNull();
  } finally {
    view.cleanup();
  }
});

domTest("code that asks again gets a new card in the same place after each decision", async () => {
  // Code asks for approvals one after another; each request has its own call, shown on the block of the code run.
  const ask = (index: number): Extract<AiTurnBlock, { kind: "tool" }> => ({
    ...runCode,
    callId: `run-approval-${index}`,
    approval: { message: `Step ${index}`, allowAlways: false },
  });
  const view = await mountTurn([ask(0)]);
  try {
    const place = view.place();
    view.button("Run code").click();
    await tick();
    await tick();
    expect(place.querySelector(".ai-turn-receipt")?.textContent).toBe("Running: Run code · report.ts");

    // The turn reports the decision; the code runs on and asks again.
    view.setBlocks([{ ...ask(0), status: "running", approved: true, approval: undefined }]);
    view.setPhase("running");
    view.setBlocks([{ ...ask(1), approved: true }]);
    view.setPhase("waiting");
    expect(place.querySelector(".ai-approval")?.textContent).toContain("Step 1");
    view.button("Reject").click();
    await tick();
    await tick();
    expect(view.decisions).toEqual([{ approved: true }, { approved: false }]);
    expect(place.querySelector(".ai-turn-receipt")?.textContent).toBe("Rejected: Run code · report.ts");

    // A rejected request does not decide the next one either.
    view.setBlocks([{ ...ask(2), approved: true }]);
    expect(place.querySelector(".ai-approval")?.textContent).toContain("Step 2");
    expect(view.place()).toBe(place);
  } finally {
    view.cleanup();
  }
});
