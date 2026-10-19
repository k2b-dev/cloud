import { expect, setSystemTime, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { AiActionCheck } from "../action-review";
import type { AiTurnBlock } from "../protocol";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const domTest = isServer ? test.skip : test;

const runCode: Extract<AiTurnBlock, { kind: "tool" }> = {
  id: "tool-run",
  callId: "run",
  kind: "tool",
  name: "code_run",
  status: "awaiting_approval",
  args: { path: "report.ts" },
  approval: { message: "Run report.ts", allowAlways: false },
};

const mountTurn = async (
  initial: AiTurnBlock[],
  options: {
    locale?: string;
    phase?: "running" | "waiting" | "stopped" | "completed";
    approve?: (input: unknown) => Promise<void>;
    check?: () => Promise<AiActionCheck>;
  } = {},
) => {
  const dom = createDomTestHarness();
  const { createSignal } = await import("solid-js");
  const { LocaleProvider } = await import("@k2b/ui");
  const { AiChatActionsProvider } = await import("./message-actions");
  const { AiTurnView } = await import("./turn-view");
  const { layoutAiTurn } = await import("./turn-layout");
  const { createAiToolDisclosureState } = await import("./tool-disclosure");
  const [blocks, setBlocks] = createSignal(initial);
  const [phase, setPhase] = createSignal<"running" | "waiting" | "stopped" | "completed">(options.phase ?? "waiting");
  const decisions: unknown[] = [];
  const continued: string[] = [];
  const dispose = render(
    () => (
      <LocaleProvider locale={options.locale ?? "en"}>
        <AiChatActionsProvider
          actions={{
            onApproval: async (_request, input) => {
              decisions.push(input);
              await options.approve?.(input);
            },
            onContinueTurn: (message) => void continued.push(message),
            ...(options.check ? { onCheckAction: options.check } : {}),
          }}
        >
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
  // A person chip's initials are decoration; the line reads the name.
  const line = () => {
    const current = place().querySelector<HTMLElement>('.k2b-chat-outcome__text[data-current="true"]');
    if (!current) return null;
    const copy = current.cloneNode(true) as HTMLElement;
    for (const avatar of copy.querySelectorAll(".k2b-reference__avatar")) avatar.remove();
    return copy.textContent?.trim() ?? null;
  };
  const outcome = () => place().querySelector<HTMLElement>(".k2b-chat-outcome");
  const question = () => place().querySelector<HTMLElement>(".k2b-chat-decision__card");
  return {
    dom,
    decisions,
    continued,
    line,
    outcome,
    question,
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

const settle = async () => {
  await tick();
  await tick();
  // The outcome line fills its live region a moment after it changes, so the same words spoken again are announced.
  await new Promise((resolve) => setTimeout(resolve, 60));
};

domTest("an answer collapses the question at once to its outcome line, which takes the focus and is announced", async () => {
  let accept!: () => void;
  const view = await mountTurn([runCode], { approve: () => new Promise<void>((resolve) => (accept = resolve)) });
  try {
    const place = view.place();
    expect(view.question()?.textContent).toContain("Run code?");
    const approve = view.button("Run code");
    approve.focus();
    approve.click();
    await settle();
    expect(view.decisions).toEqual([{ approved: true }]);
    // The server has not answered yet; the card already is its outcome line, in the same place.
    expect(view.question()).toBeNull();
    const outcome = view.outcome()!;
    expect(view.line()).toBe("Running: Run code");
    expect(document.activeElement).toBe(outcome);
    expect(outcome.querySelector('[role="status"]')?.textContent).toBe("Running: Run code");

    // The turn reports the decision and then the outcome: the same line changes only its words.
    accept();
    view.setBlocks([{ ...runCode, status: "running", approved: true, approval: undefined }]);
    view.setPhase("running");
    await settle();
    expect(view.outcome()).toBe(outcome);
    view.setBlocks([{ ...runCode, status: "completed", approved: true, approval: undefined, result: { status: "ok" } }]);
    await settle();
    expect(view.place()).toBe(place);
    expect(view.outcome()).toBe(outcome);
    expect(view.line()).toBe("Ran code");
    expect(outcome.querySelector('[role="status"]')?.textContent).toBe("Ran code");
  } finally {
    view.cleanup();
  }
});

domTest("an answer that did not arrive says so and asks again with the focus on the sentence", async () => {
  let attempts = 0;
  const view = await mountTurn([runCode], {
    locale: "de",
    approve: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
    },
  });
  try {
    view.button("Code ausführen").click();
    await settle();
    expect(view.line()).toContain("Deine Antwort zu Code ausführen kam nicht an.");
    expect(view.line()).toContain("Kam sie doch an, siehst du das Ergebnis gleich hier.");
    view.button("Noch einmal antworten").click();
    await settle();
    expect(view.question()).not.toBeNull();
    expect(document.activeElement?.classList.contains("k2b-chat-decision__sentence")).toBe(true);
    view.button("Code ausführen").click();
    await settle();
    expect(view.decisions).toEqual([{ approved: true }, { approved: true }]);
    expect(view.line()).toBe("Wird ausgeführt: Code ausführen");
  } finally {
    view.cleanup();
  }
});

domTest("an answer whose response was lost still shows the outcome the server reports", async () => {
  const view = await mountTurn([runCode], {
    approve: async () => {
      throw new Error("response lost");
    },
  });
  try {
    view.button("Run code").click();
    await settle();
    expect(view.line()).toContain("Your answer about Run code didn't arrive.");
    // The server did take the answer: its outcome replaces the lost line.
    view.setBlocks([{ ...runCode, status: "running", approved: true, approval: undefined }]);
    view.setPhase("running");
    await settle();
    expect(view.line()).toBe("Running: Run code");
    view.setBlocks([{ ...runCode, status: "completed", approved: true, approval: undefined, result: { status: "ok" } }]);
    await settle();
    expect(view.line()).toBe("Ran code");
  } finally {
    view.cleanup();
  }
});

domTest("a declined question and one a stop left open read as outcome lines in the reader's language", async () => {
  const view = await mountTurn([runCode], { locale: "de" });
  try {
    view.button("Nicht ausführen").click();
    await settle();
    expect(view.decisions).toEqual([{ approved: false }]);
    const outcome = view.outcome()!;
    expect(view.line()).toBe("Abgelehnt: Code ausführen Du hast abgelehnt.");
    view.setBlocks([{ ...runCode, status: "rejected", approval: undefined }]);
    await settle();
    expect(view.outcome()).toBe(outcome);
    expect(view.line()).toBe("Abgelehnt: Code ausführen Du hast abgelehnt.");
  } finally {
    view.cleanup();
  }

  const stopped = await mountTurn([{ ...runCode, status: "running", approved: false, approval: undefined }], {
    locale: "de",
    phase: "stopped",
  });
  try {
    expect(stopped.line()).toBe("Nicht ausgeführt: Code ausführen Die Antwort wurde angehalten.");
    expect(stopped.place().querySelector(".ti-circle-off")).not.toBeNull();
  } finally {
    stopped.cleanup();
  }
});

domTest("a question decided in another window says so where it stood", async () => {
  const view = await mountTurn([runCode]);
  try {
    expect(view.question()).not.toBeNull();
    view.setBlocks([{ ...runCode, status: "running", approved: true, approval: undefined }]);
    view.setPhase("running");
    await settle();
    view.setBlocks([
      { ...runCode, status: "completed", approved: true, approval: undefined, result: { status: "ok" }, at: "2026-10-17T12:02:00.000Z" },
    ]);
    await settle();
    expect(view.line()).toContain("Ran code You approved in another window.");
    // Nobody answered here, so the focus did not move.
    expect(document.activeElement).not.toBe(view.outcome());
  } finally {
    view.cleanup();
  }
});

domTest("an expired question offers to ask again through a visible message", async () => {
  const view = await mountTurn([{ ...runCode, status: "running", approved: false, approval: undefined }], { phase: "completed" });
  try {
    expect(view.line()).toContain("Not run: Run code The question expired.");
    expect(view.place().querySelector(".ti-clock-x")).not.toBeNull();
    view.button("Ask again").click();
    await settle();
    expect(view.continued).toEqual(["Please ask me again: Run code"]);
  } finally {
    view.cleanup();
  }
});

domTest("code that asks again gets a new question in the same place after each decision", async () => {
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
    await settle();
    expect(view.line()).toBe("Running: Run code");

    // The turn reports the decision; the code runs on and asks again.
    view.setBlocks([{ ...ask(0), status: "running", approved: true, approval: undefined }]);
    view.setPhase("running");
    view.setBlocks([{ ...ask(1), approved: true }]);
    view.setPhase("waiting");
    await settle();
    expect(view.question()?.textContent).toContain("Step 1");
    view.button("Don't run").click();
    await settle();
    expect(view.decisions).toEqual([{ approved: true }, { approved: false }]);
    expect(view.line()).toContain("Rejected: Run code");

    // A rejected request does not decide the next one either.
    view.setBlocks([{ ...ask(2), approved: true }]);
    await settle();
    expect(view.question()?.textContent).toContain("Step 2");
    expect(view.place()).toBe(place);
  } finally {
    view.cleanup();
  }
});

domTest("a turn stopped while it checked keeps the open outcome and its check", async () => {
  const { actionFixtures } = await import("./action-question.fixtures");
  const mail = actionFixtures("en").mail!.block;
  const view = await mountTurn([{ ...mail, approval: undefined, approved: true, status: "running", check: { state: "failed" } }], {
    phase: "stopped",
    check: async () => ({ state: "done", at: "2026-10-17T12:03:00.000Z" }),
  });
  try {
    expect(view.line()).toContain("Still not known whether this happened");
    expect(view.button("Check again")).toBeDefined();
  } finally {
    view.cleanup();
  }
});

domTest("a live check whose claim went stale offers to check again", async () => {
  setSystemTime(new Date("2026-10-17T12:10:00.000Z"));
  const { actionFixtures } = await import("./action-question.fixtures");
  const mail = actionFixtures("en").mail!.block;
  const view = await mountTurn(
    [
      {
        ...mail,
        approval: undefined,
        approved: true,
        status: "running",
        // Two minutes old against the pinned clock: past the stale limit.
        check: { state: "checking", at: "2026-10-17T12:08:00.000Z" },
      },
    ],
    { phase: "running", check: async () => ({ state: "done", at: "2026-10-17T12:10:30.000Z" }) },
  );
  try {
    expect(view.line()).toContain("Not known yet whether this happened");
    expect(view.button("Check again")).toBeDefined();
  } finally {
    view.cleanup();
    setSystemTime();
  }
});

domTest("an answer given here stays this window's answer when the block returns to its parent call", async () => {
  const child: Extract<AiTurnBlock, { kind: "tool" }> = {
    ...runCode,
    callId: "run-approval-0",
    approval: { message: "Step 0", allowAlways: false },
  };
  const view = await mountTurn([child]);
  try {
    view.button("Run code").click();
    await settle();
    // A reconnect snapshot replaces the approval request with the code run it belongs to.
    view.setBlocks([{ ...runCode, callId: "run", status: "running", approved: true, approval: undefined }]);
    view.setPhase("running");
    await settle();
    view.setBlocks([{ ...runCode, callId: "run", status: "completed", approved: true, approval: undefined, result: { status: "ok" } }]);
    await settle();
    expect(view.line()).toBe("Ran code");
    expect(view.place().textContent).not.toContain("another window");
  } finally {
    view.cleanup();
  }
});

domTest("a lost answer to an earlier question never marks the next one", async () => {
  const ask = (index: number): Extract<AiTurnBlock, { kind: "tool" }> => ({
    ...runCode,
    callId: `run-approval-${index}`,
    approval: { message: `Step ${index}`, allowAlways: false },
  });
  let fail!: (error: Error) => void;
  const view = await mountTurn([ask(0)], { approve: () => new Promise<void>((_resolve, reject) => (fail = reject)) });
  try {
    view.button("Run code").click();
    await settle();
    // The server took the first answer and the code asks for the next website before the first response is lost.
    view.setBlocks([{ ...ask(1), approved: true }]);
    await settle();
    fail(new Error("response lost"));
    await settle();
    expect(view.question()?.textContent).toContain("Step 1");
    expect(view.place().textContent).not.toContain("didn't arrive");
  } finally {
    view.cleanup();
  }
});

domTest("a check that could not settle the outcome is asked again only on request, and never repeats the call", async () => {
  const { actionFixtures } = await import("./action-question.fixtures");
  const mail = actionFixtures("en").mail!.block;
  let checks = 0;
  const view = await mountTurn(
    [
      {
        ...mail,
        approval: undefined,
        approved: true,
        status: "failed",
        isError: true,
        result: "ACTION_OUTCOME_UNKNOWN: lost",
        check: { state: "failed" },
        at: "2026-10-17T12:02:00.000Z",
      },
    ],
    {
      phase: "completed",
      check: async () => {
        checks += 1;
        return { state: "done", at: "2026-10-17T12:03:00.000Z" };
      },
    },
  );
  try {
    expect(view.line()).toContain("Still not known whether this happened");
    expect(view.button("Send to Lea Berg")).toBeUndefined();
    view.button("Check again").click();
    await settle();
    expect(checks).toBe(1);
    expect(view.decisions).toEqual([]);
    expect(view.line()).toContain("The email Maintenance window Tuesday to Lea Berg is being sent.");
    expect(view.line()).toContain("Mail already did it. I won't run it again.");
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

domTest("an app Action's catalog sentences name the question and every outcome line; the model's reason never shows", async () => {
  const english = await mountTurn([sendMail("en")]);
  try {
    expect(english.question()?.querySelector(".k2b-chat-decision__sentence")?.textContent).toBe("Send email to jana@example.com?");
    expect(english.question()?.textContent).toContain("I'm asking because Acme Mail always asks for this.");
    // Cloud's reason replaces the model's own words; the text for text-only readers is not repeated.
    expect(english.place().textContent).not.toContain("Jana asked for the offer.");
    expect(english.place().textContent).not.toContain("Acme Mail: Send email to jana@example.com");
    english.button("Send email").click();
    await settle();
    expect(english.line()).toBe("Running: Send email to jana@example.com");
    const outcome = english.outcome();
    english.setPhase("running");
    await settle();
    expect(english.outcome()).toBe(outcome);
    english.setBlocks([
      {
        ...sendMail("en"),
        status: "completed",
        approved: true,
        approval: undefined,
        result: { data: { messageId: "M-42" }, summary: "Queued" },
      },
    ]);
    await settle();
    expect(english.outcome()).toBe(outcome);
    expect(english.line()).toBe("Sent email to jana@example.com (M-42)");
  } finally {
    english.cleanup();
  }

  const german = await mountTurn([sendMail("de")], { locale: "de" });
  try {
    expect(german.question()?.querySelector(".k2b-chat-decision__sentence")?.textContent).toBe("E-Mail an jana@example.com senden?");
    expect(german.place().textContent).not.toContain("Warum");
    german.button("Nicht ausführen").click();
    await settle();
    expect(german.line()).toBe("E-Mail an jana@example.com nicht gesendet Du hast abgelehnt.");
  } finally {
    german.cleanup();
  }

  // A stop before the decision leaves the app's not-run sentence; a result without the data a sentence needs keeps the app's summary.
  const stopped = await mountTurn([{ ...sendMail("de"), status: "running", approval: undefined }], { locale: "de", phase: "stopped" });
  try {
    expect(stopped.line()).toBe("E-Mail an jana@example.com nicht gesendet Die Antwort wurde angehalten.");
  } finally {
    stopped.cleanup();
  }
  const withoutData = await mountTurn(
    [{ ...sendMail("de"), status: "completed", approved: true, approval: undefined, result: { data: {}, summary: "Zugestellt" } }],
    { locale: "de", phase: "stopped" },
  );
  try {
    expect(withoutData.line()).toBe("Zugestellt");
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
    expect(view.question()?.querySelector(".k2b-chat-decision__sentence")?.textContent).toBe(
      "E-Mail senden · Empfänger: jana@example.com und max@example.com?",
    );
    expect(view.place().textContent).not.toContain("Warum");
  } finally {
    view.cleanup();
  }
});

domTest("a value shaped like a date that is no real day never breaks the question or its outcome", async () => {
  const block = sendMail("en");
  block.presentation = {
    ...block.presentation!,
    sentences: { approval: "Send email at {input.sendAt}", rejected: "Did not send email at {input.sendAt}" },
    fields: [{ path: "input.sendAt", label: "Delivery time", format: "date-time" }],
  };
  block.args = { sendAt: "0000-00-00" };
  const view = await mountTurn([block]);
  try {
    expect(view.question()?.querySelector(".k2b-chat-decision__sentence")?.textContent).toBe("Send email at 0000-00-00?");
    view.button("Don't run").click();
    await settle();
    expect(view.line()).toBe("Did not send email at 0000-00-00 You declined.");
  } finally {
    view.cleanup();
  }
});

domTest("without a done sentence the outcome is the app's own summary of the call, such as a scheduled send", async () => {
  const block = sendMail("en");
  const { done: _done, ...sentences } = block.presentation!.sentences!;
  block.presentation = { ...block.presentation!, sentences };
  const view = await mountTurn(
    [{ ...block, status: "completed", approved: true, approval: undefined, result: { data: {}, summary: "Scheduled “Q4 report”." } }],
    { phase: "stopped" },
  );
  try {
    expect(view.line()).toBe("Scheduled “Q4 report”.");
  } finally {
    view.cleanup();
  }
});

domTest("a check settled elsewhere replaces this card's own older check answer", async () => {
  const { actionFixtures } = await import("./action-question.fixtures");
  const mail = actionFixtures("en").mail!.block;
  const failed = {
    ...mail,
    approval: undefined,
    approved: true as const,
    status: "failed" as const,
    isError: true,
    result: "ACTION_OUTCOME_UNKNOWN: lost",
    at: "2026-10-17T12:02:00.000Z",
  };
  const view = await mountTurn([{ ...failed, check: { state: "failed", at: "2026-10-17T12:02:00.000Z" } }], {
    phase: "completed",
    check: async () => ({ state: "pending", at: "2026-10-17T12:03:00.000Z" }),
  });
  try {
    view.button("Check again").click();
    await settle();
    expect(view.line()).toContain("Mail doesn't know yet either.");
    // Another window's check settled the call; the refreshed history carries it.
    view.setBlocks([{ ...failed, check: { state: "done", at: "2026-10-17T12:04:00.000Z" } }]);
    await settle();
    expect(view.line()).toContain("Mail already did it. I won't run it again.");
    expect(view.button("Check again")).toBeUndefined();
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
    result: { status: "ok" },
    receipts: [{ method: "GET", url: "https://query1.finance.yahoo.com/v8/finance/chart/NVDA?range=1d" }],
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
