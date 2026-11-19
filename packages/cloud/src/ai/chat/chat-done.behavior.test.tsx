import { expect, test } from "bun:test";
import { Chat, LocaleProvider } from "@k2b/ui";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { AiStoredMessage } from "../types";
import { chatDoneFact, chatDoneMessage } from "./chat-done.fixture";
import { AiChatActionsProvider, createAiChatTimeline } from "./presentation";

test("a completion preserves existing messages and draft focus; its result is a keyboard link to the saved answer", () => {
  const dom = createDomTestHarness();
  const [messages, setMessages] = createSignal<AiStoredMessage[]>([chatDoneMessage(1, "Mit dem Zug zur Messe.")]);
  const dispose = render(() => <LocaleProvider locale="de"><AiChatActionsProvider actions={{}}>{(() => {
    const timeline = createAiChatTimeline({ messages, activeTurn: () => null, timeZone: "UTC" });
    return <><Chat.Timeline items={timeline()} /><textarea aria-label="Nachricht" /></>;
  })()}</AiChatActionsProvider></LocaleProvider>, dom.root);
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
  } finally { dispose(); dom.cleanup(); }
});
