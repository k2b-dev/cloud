import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import type { AiChatTimelineSource } from "@k2b/cloud/ai/ui";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import { authoringStopNow, authoringStopState, createStoppedAuthoringFixture } from "./authoring-stop.test-fixture";

// Shared UI modules register DOM events when they load, as in neighbouring behavior tests.
const bootstrap = createDomTestHarness();
const [{ AiChatActionsProvider, createAiChatTimeline }, { Chat, LocaleProvider }, { default: AssistantAuthoringStop }] = await Promise.all([
  import("@k2b/cloud/ai/ui"),
  import("@k2b/ui"),
  import("./AssistantAuthoringStop"),
]);
bootstrap.cleanup();

const domTest = isServer ? test.skip : test;
beforeEach(() => setSystemTime(new Date(authoringStopNow)));
afterEach(() => setSystemTime());

domTest("a receipt arriving before the turn settles acquires its action when continuation becomes available", () => {
  const dom = createDomTestHarness();
  const [continuable, setContinuable] = createSignal(false);
  const dispose = render(
    () => (
      <LocaleProvider locale="de">
        <AiChatActionsProvider actions={{ onContinueTurn: () => {} }}>
          <AssistantAuthoringStop state={authoringStopState("input_tokens", "draft")} continuable={continuable} superseded={() => false} />
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
              renderCodeAuthoringStop: (state, continuable, superseded) => (
                <AssistantAuthoringStop state={state} continuable={continuable} superseded={superseded} />
              ),
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
    const quiet = () =>
      Array.from(
        dom.root.querySelectorAll(".assistant-authoring-stop .k2b-notice-card__detail-text > [role]"),
        (node) => node.textContent,
      ).join("");
    try {
      expect(continued).toEqual([]);
      expect(dom.root.querySelector(".k2b-chat-task-list")).toBeNull();
      expect(quiet()).toBe(
        locale === "de"
          ? "Derselbe Fehler kam mehrmals · Entwurf gespeichert, noch keine Version"
          : "The same error came up several times · Draft saved, no version yet",
      );
      expect(button().getAttribute("data-variant")).toBe("secondary");
      setBusy(true);
      expect(button().disabled).toBe(true);
      expect(quiet()).toBe(locale === "de" ? "Geht, sobald Gustav fertig ist." : "Available when Gustav is finished.");
      button().click();
      expect(continued).toHaveLength(0);
      setBusy(false);
      button().focus();
      button().click();
      await Promise.resolve();
      await Promise.resolve();
      expect(continued).toHaveLength(1);
      expect(quiet()).toBe(locale === "de" ? "Das ging nicht. Versuch es noch einmal." : "Could not continue. Try again.");
      const alert = dom.root.querySelector('[role="alert"]');
      const status = dom.root.querySelector('[role="status"]');
      expect(alert?.textContent).toBe(quiet());
      expect(status?.textContent).toBe("");
      const originalButton = button();
      expect(dom.document.activeElement).toBe(originalButton);
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
      expect(dom.root.querySelector('[role="alert"]')).toBe(alert);
      expect(dom.root.querySelector('[role="status"]')).toBe(status);
      expect(history().at(-1)?.loopId).toBe("next");
      expect(dom.root.querySelector(".assistant-authoring-stop button")).toBeNull();
      expect(dom.root.querySelector(".assistant-authoring-stop .k2b-notice-card__actions")).toBeNull();
      expect(dom.root.querySelector('[role="alert"]')?.textContent).toBe("");
    } finally {
      dispose();
      dom.cleanup();
    }
  });
}

for (const newer of ["message", "same-loop-message", "turn"] as const) {
  domTest(`a newer ${newer} releases only the overtaken receipt's action space`, async () => {
    const { messages } = await createStoppedAuthoringFixture("de");
    const dom = createDomTestHarness();
    const [history, setHistory] = createSignal(messages);
    const [activeTurn, setActiveTurn] = createSignal<ReturnType<AiChatTimelineSource["activeTurn"]>>(null);
    const Timeline = () => {
      const items = createAiChatTimeline({ messages: history, activeTurn });
      return <Chat.Timeline items={items()} />;
    };
    const dispose = render(
      () => (
        <LocaleProvider locale="de">
          <AiChatActionsProvider
            actions={{
              onContinueTurn: () => {},
              renderCodeAuthoringStop: (state, continuable, superseded) => (
                <AssistantAuthoringStop state={state} continuable={continuable} superseded={superseded} />
              ),
            }}
          >
            <Timeline />
          </AiChatActionsProvider>
        </LocaleProvider>
      ),
      dom.root,
    );
    try {
      const card = dom.root.querySelector(".assistant-authoring-stop");
      const button = card?.querySelector("button");
      expect(button).not.toBeNull();
      expect(card?.querySelector(".k2b-notice-card__actions")).not.toBeNull();
      expect(button?.getAttribute("aria-hidden")).toBeNull();
      if (newer === "turn") {
        setActiveTurn({ turnId: "newer", attempt: 1, seq: 3, status: "running", blocks: [], modelId: null });
      } else {
        setHistory([...messages, { ...messages[0]!, id: "newer", seq: 3, loopId: newer === "same-loop-message" ? "turn" : "newer" }]);
      }
      expect(dom.root.querySelector(".assistant-authoring-stop")).toBe(card);
      expect(card?.querySelector("button")).toBeNull();
      expect(card?.querySelector(".k2b-notice-card__actions")).toBeNull();
    } finally {
      dispose();
      dom.cleanup();
    }
  });
}
