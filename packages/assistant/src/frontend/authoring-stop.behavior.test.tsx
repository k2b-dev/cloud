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
      expect(dom.root.textContent).toContain(locale === "de" ? "dasselbe Problem" : "the same problem");
      expect(dom.root.textContent).toContain(locale === "de" ? "Erledigt: 2 Arbeitsschritte" : "Completed: 2 work steps");
      expect(dom.root.textContent).toContain(locale === "de" ? "1 Entwurf mit Beispielen testen" : "test 1 draft with examples");
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
      expect(dom.root.querySelector('[role="alert"]')?.textContent).toContain(
        locale === "de" ? "nicht fortgesetzt" : "could not be continued",
      );
      const originalButton = button();
      originalButton.focus();
      setHistory(messages.map((message) => ({ ...message, meta: message.meta ? { ...message.meta } : null })));
      expect(button() === originalButton).toBe(true);
      expect(dom.root.ownerDocument.activeElement === originalButton).toBe(true);
      expect(dom.root.querySelector('[role="alert"]')?.textContent).toContain(
        locale === "de" ? "nicht fortgesetzt" : "could not be continued",
      );
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

domTest("a stop before a confirmed draft says what remains and never claims a saved result", async () => {
  const dom = createDomTestHarness();
  const { LocaleProvider } = await import("@k2b/ui");
  const { default: AssistantAuthoringStop } = await import("./AssistantAuthoringStop");
  const state: AiCodeAuthoringStop = { reason: "input_tokens", completedSteps: 0, drafts: 0, unchecked: 0, untested: 0, unsubmitted: 0 };
  const dispose = render(
    () => (
      <LocaleProvider locale="en">
        <AssistantAuthoringStop state={state} continuable={() => false} />
      </LocaleProvider>
    ),
    dom.root,
  );
  try {
    expect(dom.root.textContent).toContain("too costly");
    expect(dom.root.textContent).toContain("A saved draft has not been confirmed yet");
    expect(dom.root.querySelector("button")?.disabled).toBe(true);
  } finally {
    dispose();
    dom.cleanup();
  }
});
