import { expect, test } from "bun:test";
import type { AiCodeAuthoringStop } from "@k2b/cloud/ai";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import { createStoppedAuthoringFixture } from "./authoring-stop.test-fixture";

const domTest = isServer ? test.skip : test;

for (const locale of ["de", "en"]) {
  domTest(`a persisted budget stop explains real progress in ${locale} and continues only by consent`, async () => {
    const { messages, state } = await createStoppedAuthoringFixture(locale);
    expect(state).toEqual({ reason: "repeated_error", completedSteps: 2, drafts: 1, unchecked: 0, untested: 1, unsubmitted: 1 });
    const dom = createDomTestHarness();
    const { Chat, LocaleProvider } = await import("@k2b/ui");
    const { AiChatActionsProvider, createAiChatTimeline } = await import("@k2b/cloud/ai/ui");
    const { default: AssistantAuthoringStop } = await import("./AssistantAuthoringStop");
    const continued: string[] = [];
    const [history, setHistory] = createSignal(messages);
    const [busy, setBusy] = createSignal(false);
    let reject = true;
    let release!: () => void;
    const Timeline = () => {
      const timeline = createAiChatTimeline({ messages: history, activeTurn: () => null });
      return <Chat.Timeline items={timeline()} />;
    };
    const dispose = render(
      () => (
        <LocaleProvider locale={locale}>
          <AiChatActionsProvider
            actions={{
              renderCodeAuthoringStop: (state, continuable) => <AssistantAuthoringStop state={state} continuable={continuable} />,
              actionDisabled: busy,
              onContinueTurn: async (message) => {
                continued.push(message);
                if (reject) throw new Error("offline");
                await new Promise<void>((resolve) => {
                  release = resolve;
                });
                setHistory([
                  ...messages,
                  {
                    ...messages[0]!,
                    id: "new-request",
                    seq: 100,
                    loopId: "new-turn",
                    message: { role: "user", content: [message] },
                    meta: null,
                  },
                ]);
              },
            }}
          >
            <Timeline />
          </AiChatActionsProvider>
        </LocaleProvider>
      ),
      dom.root,
    );
    const button = () =>
      Array.from(dom.root.querySelectorAll("button")).find(
        (node) => node.textContent?.trim() === (locale === "de" ? "Weiterarbeiten" : "Continue"),
      )!;
    try {
      expect(continued).toEqual([]);
      // One still list of the steps (Chat.TaskList): done ones checked, open ones open, each with its status word.
      const rows = Array.from(dom.root.querySelectorAll(".k2b-chat-task-list .k2b-chat-task"), (row) => ({
        status: row.getAttribute("data-status"),
        text: row.querySelector(".k2b-chat-task__content")?.textContent,
      }));
      expect(dom.root.querySelector(".k2b-notice-card__title")?.textContent).toBe(
        locale === "de" ? "Gustav macht eine Pause" : "Gustav is taking a break",
      );
      expect(dom.root.querySelector(".k2b-notice-card__description")?.textContent).toBe(
        locale === "de"
          ? "Derselbe Fehler kam mehrmals. Er wartet jetzt auf dich."
          : "The same error came up several times. He is waiting for you now.",
      );
      expect(rows).toEqual(
        locale === "de"
          ? [
              { status: "completed", text: "Entwurf geprüft" },
              { status: "pending", text: "Mit Beispielen testen" },
              { status: "pending", text: "Version speichern" },
            ]
          : [
              { status: "completed", text: "Draft checked" },
              { status: "pending", text: "Test with examples" },
              { status: "pending", text: "Save a version" },
            ],
      );
      // The work stopped: no ring turns.
      expect(dom.root.querySelector('.k2b-chat-task[data-status="in_progress"]')).toBeNull();
      expect(dom.root.textContent).toContain(
        locale === "de" ? "Der Entwurf ist gesichert, aber noch keine Version." : "The draft is safe, but there is no version yet.",
      );
      expect(button().getAttribute("data-variant")).toBe("secondary");
      expect(dom.root.textContent).not.toMatch(/code_test_invalid_fixture|private-id|\.tsx?/);
      setBusy(true);
      expect(button().disabled).toBe(true);
      button().click();
      expect(continued).toHaveLength(0);
      setBusy(false);
      button().click();
      await Promise.resolve();
      await Promise.resolve();
      expect(continued).toHaveLength(1);
      expect(dom.root.querySelector('[role="alert"]')?.textContent).toContain(locale === "de" ? "Das ging nicht." : "Could not continue.");
      const originalButton = button();
      originalButton.focus();
      setHistory(messages.map((message) => ({ ...message, meta: message.meta ? { ...message.meta } : null })));
      expect(button() === originalButton).toBe(true);
      expect(dom.root.ownerDocument.activeElement === originalButton).toBe(true);
      expect(dom.root.querySelector('[role="alert"]')?.textContent).toContain(locale === "de" ? "Das ging nicht." : "Could not continue.");
      reject = false;
      button().focus();
      button().click();
      button().click();
      expect(continued).toHaveLength(2);
      expect(button().disabled).toBe(true);
      expect(dom.root.querySelector('[role="status"]')).not.toBeNull();
      release();
      await Promise.resolve();
      await Promise.resolve();
      expect(history().at(-1)?.loopId).toBe("new-turn");
      expect(button().disabled).toBe(true);
      expect(messages.at(-1)?.meta?.codeAuthoringStop?.drafts).toBe(1);
    } finally {
      dispose();
      dom.cleanup();
    }
  });
}

for (const [name, state, reason, done, open, saved] of [
  [
    "a stop before a confirmed draft says what remains and never claims a saved result",
    { reason: "input_tokens", completedSteps: 0, drafts: 0, unchecked: 0, untested: 0, unsubmitted: 0 },
    "He has already tried a lot in this step and is waiting for you now.",
    null,
    ["Prepare and check the draft"],
    "There is no draft yet.",
  ],
  [
    "an attempt limit with several drafts counts what each step still needs",
    { reason: "model_calls", completedSteps: 7, drafts: 2, unchecked: 1, untested: 2, unsubmitted: 2 },
    "He has already tried a lot in this step and is waiting for you now.",
    null,
    ["Check 1 draft", "Test 2 drafts with examples", "Save 2 versions"],
    "The drafts are safe, but there are no versions yet.",
  ],
  [
    "a submitted version claims no check or test the receipt cannot prove and leaves only the review open",
    { reason: "input_tokens", completedSteps: 1, drafts: 1, unchecked: 0, untested: 0, unsubmitted: 0 },
    "He has already tried a lot in this step and is waiting for you now.",
    null,
    ["Review the saved result"],
    "The version is submitted.",
  ],
  [
    "mixed submitted and open drafts claim nothing for the submitted one",
    { reason: "repeated_error", completedSteps: 4, drafts: 2, unchecked: 0, untested: 0, unsubmitted: 1 },
    "The same error came up several times. He is waiting for you now.",
    null,
    ["Save 1 version"],
    "1 draft is safe, but has no version yet. 1 version is submitted.",
  ],
  [
    "a checked and tested draft lists both as done and only the version as open",
    { reason: "model_calls", completedSteps: 3, drafts: 1, unchecked: 0, untested: 0, unsubmitted: 1 },
    "He has already tried a lot in this step and is waiting for you now.",
    ["Draft checked", "Tested with examples"],
    ["Save a version"],
    "The draft is safe, but there is no version yet.",
  ],
] as const) {
  domTest(name, async () => {
    const dom = createDomTestHarness();
    const { LocaleProvider } = await import("@k2b/ui");
    const { default: AssistantAuthoringStop } = await import("./AssistantAuthoringStop");
    const dispose = render(
      () => (
        <LocaleProvider locale="en">
          <AssistantAuthoringStop state={state as AiCodeAuthoringStop} continuable={() => false} />
        </LocaleProvider>
      ),
      dom.root,
    );
    try {
      const group = (status: string) =>
        Array.from(
          dom.root.querySelectorAll(`.k2b-chat-task[data-status="${status}"] .k2b-chat-task__content`),
          (item) => item.textContent,
        );
      expect(dom.root.querySelector(".k2b-notice-card__description")?.textContent).toBe(reason);
      expect(group("completed").length ? group("completed") : null).toEqual(done ? [...done] : null);
      expect(group("pending")).toEqual([...open]);
      expect(dom.root.querySelector(".assistant-authoring-stop__meta")?.textContent).toContain(saved);
      expect(dom.root.querySelector("button")?.disabled).toBe(true);
    } finally {
      dispose();
      dom.cleanup();
    }
  });
}
