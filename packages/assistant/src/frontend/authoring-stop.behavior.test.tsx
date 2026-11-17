import { expect, test } from "bun:test";
import { AiChatActionsProvider, createAiChatTimeline } from "@k2b/cloud/ai/ui";
import { Chat, LocaleProvider } from "@k2b/ui";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import AssistantAuthoringStop from "./AssistantAuthoringStop";
import { authoringStopState, createStoppedAuthoringFixture } from "./authoring-stop.test-fixture";

const domTest = isServer ? test.skip : test;

domTest("a receipt arriving before the turn settles acquires its action when continuation becomes available", () => {
  const dom = createDomTestHarness();
  const [continuable, setContinuable] = createSignal(false);
  const dispose = render(
    () => (
      <LocaleProvider locale="de">
        <AiChatActionsProvider actions={{ onContinueTurn: () => {} }}>
          <AssistantAuthoringStop state={authoringStopState("input_tokens", "draft")} continuable={continuable} />
        </AiChatActionsProvider>
      </LocaleProvider>
    ),
    dom.root,
  );
  try {
    const button = dom.root.querySelector("button")!;
    expect(button.getAttribute("aria-hidden")).toBe("true");
    expect(button.disabled).toBe(true);
    setContinuable(true);
    expect(dom.root.querySelector("button")).toBe(button);
    expect(button.disabled).toBe(false);
    setContinuable(false);
    expect(dom.root.querySelector("button")?.getAttribute("aria-hidden")).toBe("true");
  } finally {
    dispose();
    dom.cleanup();
  }
});
for (const locale of ["de", "en"]) {
  domTest(`continues the persisted pause only by consent, with recovery and stable focus (${locale})`, async () => {
    const { messages } = await createStoppedAuthoringFixture(locale);
    const dom = createDomTestHarness();
    const continued: string[] = [];
    const [history, setHistory] = createSignal(messages);
    const [busy, setBusy] = createSignal(false);
    let reject = true;
    let release!: () => void;
    const Timeline = () => {
      const items = createAiChatTimeline({ messages: history, activeTurn: () => null });
      return <Chat.Timeline items={items()} />;
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
                  { ...messages[0]!, id: "next", seq: 3, loopId: "next", message: { role: "user", content: [message] } },
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
    const button = () => dom.root.querySelector<HTMLButtonElement>(".assistant-authoring-stop button")!;
    const quiet = () => dom.root.querySelector('.assistant-authoring-stop__meta > :not([aria-hidden="true"])')?.textContent;
    try {
      expect(continued).toEqual([]);
      expect(dom.root.querySelector(".k2b-chat-task-list")).toBeNull();
      expect(quiet()).toBe(
        locale === "de"
          ? "Derselbe Fehler kam mehrmals · Entwurf gespeichert, noch keine Version"
          : "The same error came up several times · Draft saved, no version yet",
      );
      expect(button().getAttribute("data-variant")).toBe("primary");
      setBusy(true);
      expect(button().disabled).toBe(true);
      expect(quiet()).toBe(locale === "de" ? "Geht, sobald Gustav fertig ist." : "Available when Gustav is finished.");
      button().click();
      expect(continued).toHaveLength(0);
      setBusy(false);
      button().click();
      await Promise.resolve();
      await Promise.resolve();
      expect(continued).toHaveLength(1);
      expect(quiet()).toBe(locale === "de" ? "Das ging nicht. Versuch es noch einmal." : "Could not continue. Try again.");
      const originalButton = button();
      originalButton.focus();
      setHistory(messages.map((message) => ({ ...message, meta: message.meta ? { ...message.meta } : null })));
      expect(button()).toBe(originalButton);
      expect(dom.document.activeElement).toBe(originalButton);
      reject = false;
      button().click();
      button().click();
      expect(continued).toHaveLength(2);
      expect(button().disabled).toBe(true);
      expect(quiet()).toBe(locale === "de" ? "Gustav macht weiter …" : "Gustav is continuing …");
      release();
      await Promise.resolve();
      await Promise.resolve();
      expect(history().at(-1)?.loopId).toBe("next");
      expect(button().getAttribute("aria-hidden")).toBe("true");
      expect(button().disabled).toBe(true);
      expect(dom.root.querySelector('[role="alert"]')).toBeNull();
    } finally {
      dispose();
      dom.cleanup();
    }
  });
}
