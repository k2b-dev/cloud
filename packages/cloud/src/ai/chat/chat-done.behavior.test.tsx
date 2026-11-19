import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { chatDoneFact, chatDoneMessage } from "../../../../../scripts/fixtures/chat-done";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { AiStoredMessage } from "../types";

test("a completion preserves existing messages and draft focus; its result is a keyboard link to the saved answer", async () => {
  const dom = createDomTestHarness();
  const { Chat, LocaleProvider } = await import("@k2b/ui");
  const { AiChatActionsProvider, createAiChatTimeline } = await import("./presentation");
  const [messages, setMessages] = createSignal<AiStoredMessage[]>([chatDoneMessage(1, "Mit dem Zug zur Messe.")]);
  const dispose = render(
    () => (
      <LocaleProvider locale="de">
        <AiChatActionsProvider actions={{}}>
          {(() => {
            const timeline = createAiChatTimeline({ messages, activeTurn: () => null, timeZone: "UTC" });
            return (
              <>
                <Chat.Timeline items={timeline()} />
                <textarea aria-label="Nachricht" />
              </>
            );
          })()}
        </AiChatActionsProvider>
      </LocaleProvider>
    ),
    dom.root,
  );
  try {
    const answer = dom.root.querySelector("article");
    const field = dom.root.querySelector("textarea")!;
    field.value = "Mein Entwurf";
    field.focus();
    setMessages((messages) => [...messages, chatDoneFact()]);
    expect(dom.root.querySelector("article")).toBe(answer);
    expect(dom.document.activeElement).toBe(field);
    expect(field.value).toBe("Mein Entwurf");
    const link = dom.root.querySelector<HTMLAnchorElement>(".ai-chat-done-line a")!;
    expect(link.textContent).toContain("Ergebnis ansehen");
    link.focus();
    expect(dom.document.activeElement).toBe(link);
    expect(new URL(link.href).searchParams.get("message")).toBe("2");
    expect(new URL(link.href).searchParams.get("conversation")).toBe("Target");
  } finally {
    dispose();
    dom.cleanup();
  }
});

test("answer details load on selection and retain their existing localized content", async () => {
  const dom = createDomTestHarness();
  const { LocaleProvider, dialogCore } = await import("@k2b/ui");
  const { createAssistantMessageActions } = await import("./message-actions");
  let info: (() => void | Promise<void>) | undefined;
  const entry = chatDoneMessage(1, "Die Hotels sind verglichen.", { providerModel: "Fixture model" });
  const dispose = render(
    () => (
      <LocaleProvider locale="de">
        {(() => {
          info = createAssistantMessageActions({ entry, entries: [entry], copyText: "Die Hotels sind verglichen.", actions: {} }).find(
            (action) => action.id === "info",
          )?.onSelect;
          return null;
        })()}
      </LocaleProvider>
    ),
    dom.root,
  );
  try {
    expect(dom.document.querySelector("dialog[open]")).toBeNull();
    expect(info).toBeDefined();
    await info!();
    expect(dom.document.querySelector("dialog[open]")?.textContent).toContain("Fixture model");
    expect(dom.document.querySelector("dialog[open]")?.textContent).toContain("Verbrauch");
  } finally {
    dialogCore.close();
    dispose();
    dom.cleanup();
  }
});
