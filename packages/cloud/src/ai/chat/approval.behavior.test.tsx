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
    expect(receipt.textContent).toBe("Running: Run code");
    expect(document.activeElement).toBe(place);

    // The turn reports the decision and then the outcome: the same row changes only its words.
    view.setBlocks([{ ...runCode, status: "running", approved: true, approval: undefined }]);
    view.setPhase("running");
    expect(place.querySelector(".ai-turn-receipt")).toBe(receipt);
    view.setBlocks([{ ...runCode, status: "completed", approved: true, approval: undefined, result: { status: "ok" } }]);
    expect(place.querySelector(".ai-turn-receipt")).toBe(receipt);
    expect(receipt.textContent).toBe("Approved: Run code");
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
    expect(receipt.textContent).toBe("Abgelehnt: Code ausführen");
    view.setBlocks([{ ...runCode, status: "rejected", approval: undefined }]);
    expect(view.place().querySelector(".ai-turn-receipt")).toBe(receipt);
    expect(receipt.textContent).toBe("Abgelehnt: Code ausführen");
  } finally {
    view.cleanup();
  }

  const stopped = await mountTurn([{ ...runCode, status: "running", approved: true, approval: undefined }], {
    locale: "de",
    phase: "stopped",
  });
  try {
    expect(stopped.place().textContent).toBe("Nicht ausgeführt: Code ausführen · gestoppt");
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
    expect(place.textContent).toBe("Nicht ausgeführt: Code ausführen · gestoppt");
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
    expect(place.querySelector(".ai-turn-receipt")?.textContent).toBe("Running: Run code");

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
    expect(place.querySelector(".ai-turn-receipt")?.textContent).toBe("Rejected: Run code");

    // A rejected request does not decide the next one either.
    view.setBlocks([{ ...ask(2), approved: true }]);
    expect(place.querySelector(".ai-approval")?.textContent).toContain("Step 2");
    expect(view.place()).toBe(place);
  } finally {
    view.cleanup();
  }
});

/** An app Action that words itself, the way its saved presentation reaches the chat in each locale. */
const sendMail = (locale: "en" | "de"): Extract<AiTurnBlock, { kind: "tool" }> => ({
  id: "tool-send",
  callId: "send",
  kind: "tool",
  name: "acme-mail__action__message_dot_send",
  status: "awaiting_approval",
  args: {
    to: [{ name: "Jana Berger", address: "jana@example.com" }],
    subject: "Offer",
    approvalReason: locale === "de" ? "Jana hat um das Angebot gebeten." : "Jana asked for the offer.",
  },
  presentation: {
    kind: "capability",
    appId: "acme-mail",
    appName: "Acme Mail",
    appIcon: "ti ti-mail",
    title: locale === "de" ? "E-Mail senden" : "Send email",
    capabilityKind: "action",
    sentences:
      locale === "de"
        ? {
            approval: "E-Mail an {input.to} senden",
            done: "E-Mail an {input.to} gesendet ({data.messageId})",
            rejected: "E-Mail an {input.to} nicht gesendet",
            notRun: "E-Mail an {input.to} nicht gesendet",
          }
        : {
            approval: "Send email to {input.to}",
            done: "Sent email to {input.to} ({data.messageId})",
            rejected: "Did not send email to {input.to}",
            notRun: "Email to {input.to} not sent",
          },
    fields: [{ path: "input.to", label: locale === "de" ? "Empfänger" : "Recipients" }, { path: "data.messageId" }],
    approvalReason: true,
  },
  approval: { message: "Acme Mail: Send email to jana@example.com", allowAlways: false },
});

domTest("an app Action's own sentences name the card, the model's labelled reason, and every receipt", async () => {
  const english = await mountTurn([sendMail("en")]);
  try {
    const card = english.place().querySelector<HTMLElement>(".ai-approval")!;
    expect(card.querySelector(".ai-approval__title")?.textContent).toBe("Send email to jana@example.com");
    expect(card.querySelector(".ai-approval__sub")?.textContent).toBe("Acme Mail · Runs only after you approve it");
    // The model's reason adds to the app's sentence under its own label; the approval text for text-only readers is not repeated.
    expect(card.textContent).toContain("Why: Jana asked for the offer.");
    expect(card.textContent).not.toContain("Acme Mail: Send email to jana@example.com");
    english.button("Send email to jana@example.com").click();
    await tick();
    await tick();
    const receipt = english.place().querySelector<HTMLElement>(".ai-turn-receipt")!;
    expect(receipt.textContent).toBe("Running: Send email to jana@example.com");
    english.setPhase("running");
    english.setBlocks([
      {
        ...sendMail("en"),
        status: "completed",
        approved: true,
        approval: undefined,
        result: { data: { messageId: "M-42" }, summary: "Queued" },
      },
    ]);
    expect(english.place().querySelector(".ai-turn-receipt")).toBe(receipt);
    expect(receipt.textContent).toBe("Sent email to jana@example.com (M-42)");
  } finally {
    english.cleanup();
  }

  const german = await mountTurn([sendMail("de")], { locale: "de" });
  try {
    const card = german.place().querySelector<HTMLElement>(".ai-approval")!;
    expect(card.querySelector(".ai-approval__title")?.textContent).toBe("E-Mail an jana@example.com senden");
    expect(card.querySelector(".ai-approval__sub")?.textContent).toBe("Acme Mail · Wird erst nach deiner Freigabe ausgeführt");
    expect(card.textContent).toContain("Warum: Jana hat um das Angebot gebeten.");
    german.button("Ablehnen").click();
    await tick();
    await tick();
    expect(german.place().querySelector(".ai-turn-receipt")?.textContent).toBe("E-Mail an jana@example.com nicht gesendet");
  } finally {
    german.cleanup();
  }

  // A stop before the decision leaves the app's not-run sentence; a result without the data a sentence needs keeps the generic words.
  const stopped = await mountTurn([{ ...sendMail("de"), status: "running", approval: undefined }], { locale: "de", phase: "stopped" });
  try {
    expect(stopped.place().textContent).toBe("E-Mail an jana@example.com nicht gesendet · gestoppt");
  } finally {
    stopped.cleanup();
  }
  const withoutData = await mountTurn(
    [{ ...sendMail("de"), status: "completed", approved: true, approval: undefined, result: { data: {}, summary: "Zugestellt" } }],
    { locale: "de", phase: "stopped" },
  );
  try {
    expect(withoutData.place().textContent).toBe("Zugestellt");
  } finally {
    withoutData.cleanup();
  }
});

domTest("an Action without sentences reads as its title with its labelled fields", async () => {
  const plain = sendMail("de");
  plain.presentation = { ...plain.presentation!, sentences: undefined };
  plain.args = { to: [{ name: "Jana Berger", address: "jana@example.com" }, { address: "max@example.com" }] };
  const view = await mountTurn([plain], { locale: "de" });
  try {
    const card = view.place().querySelector<HTMLElement>(".ai-approval")!;
    expect(card.querySelector(".ai-approval__title")?.textContent).toBe("E-Mail senden · Empfänger: jana@example.com und max@example.com");
    // No reason, no label: the card adds nothing the model did not say.
    expect(card.textContent).not.toContain("Warum");
  } finally {
    view.cleanup();
  }
  // Input that did not come from the model, such as a call from Studio code, never reads as the model's reason.
  const fromCode = sendMail("de");
  fromCode.presentation = { ...fromCode.presentation!, approvalReason: undefined };
  const code = await mountTurn([fromCode], { locale: "de" });
  try {
    expect(code.place().textContent).not.toContain("Warum");
  } finally {
    code.cleanup();
  }
});

domTest("a value shaped like a date that is no real day never breaks the card or its receipt", async () => {
  const block = sendMail("en");
  block.presentation = {
    ...block.presentation!,
    sentences: { approval: "Send email at {input.sendAt}", rejected: "Did not send email at {input.sendAt}" },
    fields: [{ path: "input.sendAt", label: "Delivery time", format: "date-time" }],
  };
  block.args = { sendAt: "0000-00-00" };
  const view = await mountTurn([block]);
  try {
    expect(view.place().querySelector(".ai-approval__title")?.textContent).toBe("Send email at 0000-00-00");
    view.button("Reject").click();
    await tick();
    await tick();
    expect(view.place().querySelector(".ai-turn-receipt")?.textContent).toBe("Did not send email at 0000-00-00");
  } finally {
    view.cleanup();
  }
});

domTest("without a done sentence the receipt is the app's own summary of the call, such as a scheduled send", async () => {
  const block = sendMail("en");
  const { done: _done, ...sentences } = block.presentation!.sentences!;
  block.presentation = { ...block.presentation!, sentences };
  const view = await mountTurn(
    [{ ...block, status: "completed", approved: true, approval: undefined, result: { data: {}, summary: "Scheduled “Q4 report”." } }],
    { phase: "stopped" },
  );
  try {
    expect(view.place().textContent).toBe("Scheduled “Q4 report”.");
  } finally {
    view.cleanup();
  }
});

domTest("one click on a website receipt revokes the chat approval for its origin", async () => {
  const dom = createDomTestHarness();
  const { AiChatActionsProvider } = await import("./message-actions");
  const { AiTurnBlockView } = await import("./blocks");
  const revoked: string[] = [];
  const block: Extract<AiTurnBlock, { kind: "tool" }> = {
    id: "tool-run-receipt",
    callId: "run-receipt",
    kind: "tool",
    name: "code_run",
    status: "completed",
    args: {},
    result: {
      status: "ok",
      autoAllowedRequests: [{ method: "GET", url: "https://query1.finance.yahoo.com/v8/finance/chart/NVDA?range=1d" }],
    },
  };
  const dispose = render(
    () => (
      <AiChatActionsProvider
        actions={{
          onRevokeWebsite: async (origin) => {
            revoked.push(origin);
          },
        }}
      >
        <AiTurnBlockView turnId="turn" block={block} />
      </AiChatActionsProvider>
    ),
    dom.root,
  );
  try {
    expect(dom.root.textContent).toContain("https://query1.finance.yahoo.com/v8/finance/chart/NVDA?range=1d");
    const revoke = dom.root.querySelector<HTMLButtonElement>('button[aria-label="Revoke the approval for query1.finance.yahoo.com"]')!;
    revoke.click();
    await tick();
    await tick();
    expect(revoked).toEqual(["https://query1.finance.yahoo.com"]);
    expect(dom.root.textContent).toContain("Revoked. The next request asks again.");
    // The button keeps its place, disabled, so nothing moves.
    expect(revoke.isConnected).toBe(true);
    expect(revoke.disabled).toBe(true);
    expect(revoke.textContent?.trim()).toBe("Revoke");
  } finally {
    dispose();
    dom.cleanup();
  }
});
