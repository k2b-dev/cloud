import { expect, test } from "bun:test";
import "../../../../ui/test/solid-ssr-preload";
import { Chat, LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { AiStoredMessage } from "../types";

const { createAiChatTimeline, AiChatActionsProvider } = await import("./presentation");

// Fictitious history: the person asks, an automation and another chat write into the chat (Feinschliff v6, 6b).
const message = (seq: number, role: "user" | "assistant", text: string, extra: Partial<AiStoredMessage> = {}): AiStoredMessage => ({
  id: `m${seq}`,
  shortId: `m${seq}`,
  conversationId: "chat01",
  seq,
  kind: "message",
  message: { role, content: [{ type: "text", text }] } as AiStoredMessage["message"],
  loopId: role === "assistant" ? `turn${seq}` : null,
  modelId: null,
  providerModel: null,
  usage: null,
  stopReason: role === "assistant" ? "stop" : null,
  loopAggregate: null,
  loopDoneReason: role === "assistant" ? "stop" : null,
  compactedAt: null,
  meta: {},
  createdAt: `2026-11-09T08:0${seq}:00.000Z`,
  ...extra,
});

const render = (messages: AiStoredMessage[]) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(AiChatActionsProvider, {
          actions: { onContinueTurn: () => {}, onRetryMessage: () => {} },
          get children() {
            const timeline = createAiChatTimeline({ messages: () => messages, activeTurn: () => null });
            return createComponent(Chat.Timeline, {
              get items() {
                return timeline();
              },
            });
          },
        });
      },
    }),
  );
const articles = (html: string) => html.split("<article").slice(1);

test("a message from an automation or another chat carries its source chip; one's own stays plain", () => {
  const html = render([
    message(1, "user", "Was steht heute an?", { meta: { origin: { kind: "person", id: "u1", name: "Lena Vogt" } } }),
    message(2, "assistant", "Heute stehen 2 Termine an."),
    message(3, "user", "Briefing für Montag", {
      meta: { origin: { kind: "automation", id: "a1", name: "Morgen-Briefing", href: "/app/assistant/code/a1" } },
    }),
    message(4, "assistant", "Zuerst die Mahnung."),
    message(5, "user", "Bitte prüfe die Anzahlung", { meta: { origin: { kind: "chat", id: "c1", name: "Messe Köln" } } }),
  ]);
  const [own, , automation, , chat] = articles(html);
  expect(own).not.toContain("data-source");
  expect(automation).toContain("data-source");
  expect(automation).toContain('href="/app/assistant/code/a1"');
  expect(automation).toContain("Von Automation „Morgen-Briefing“");
  // Without the right to open the other chat, its name stands without a link.
  expect(chat).toContain("Aus dem Chat „Messe Köln“");
  expect(chat).not.toContain("<a ");
  expect(chat).toContain('data-kind="chat"');
});

test("a turn that Send now interrupted says paused and offers neither answering again nor continuing", () => {
  const interrupted = message(2, "assistant", "Im November gab es 37 PayPal-Buchungen. Die Summe prüfe ich gerade", {
    stopReason: "aborted",
    loopDoneReason: "aborted",
    meta: { queueInterrupted: true },
  });
  const html = render([
    message(1, "user", "Gleiche PayPal mit dem Konto ab"),
    interrupted,
    message(3, "user", "Und markiere die Buchungen über 300 €"),
  ]);
  expect(html).toContain("Im November gab es 37 PayPal-Buchungen");
  expect(html).toContain("Angehalten");
  // No stopped line with "Answer again", no "Continue": Gustav takes the queued message and decides himself.
  expect(html).not.toContain("ai-turn__stopped");
  expect(html).not.toContain("Weiterarbeiten");

  // The person's own stop keeps its quiet line.
  const stopped = render([message(1, "user", "Gleiche PayPal mit dem Konto ab"), { ...interrupted, meta: {} }]);
  expect(stopped).toContain("ai-turn__stopped");
  expect(stopped).not.toContain("Angehalten");
});
