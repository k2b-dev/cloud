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
  // "Paused" stands in the turn's summary line, as its status word; there is no system line for it.
  expect(html).toMatch(/class="ai-turn-work__sentence[^"]*"[^>]*>Angehalten</);
  expect(html).not.toContain("ai-turn__paused");
  // No stopped line with "Answer again", no "Continue": Gustav takes the queued message and decides himself.
  expect(html).not.toContain("ai-turn__stopped");
  expect(html).not.toContain("Weiterarbeiten");

  // The person's own stop keeps its quiet line.
  const stopped = render([message(1, "user", "Gleiche PayPal mit dem Konto ab"), { ...interrupted, meta: {} }]);
  expect(stopped).toContain("ai-turn__stopped");
  expect(stopped).not.toContain("Angehalten");
});

test("the data an automation sent stands as a quiet line under its instruction, inside its machine-written bubble", () => {
  const html = render([
    message(1, "user", "Bestätige den Kontostand aus den Daten in einem Satz.", {
      meta: {
        origin: { kind: "automation", id: "a2", name: "Kontostand", href: "/app/assistant/code/a2" },
        sourceContext: "Geschäftskonto 4.210,18 € · Stand heute, 08:00",
      },
    }),
    message(2, "assistant", "Kontostand heute um 08:00: 4.210,18 €."),
    message(3, "user", "Danke", { meta: { origin: { kind: "person", id: "u1", name: "Lena Vogt" } } }),
  ]);
  const [automation = "", , own = ""] = articles(html);
  expect(automation).toContain("data-source");
  expect(automation).toContain("Bestätige den Kontostand aus den Daten in einem Satz.");
  expect(automation).toMatch(
    /class="ai-message-data"[^>]*><i class="ti ti-database" aria-hidden="true"><\/i><span>Daten: Geschäftskonto 4\.210,18 € · Stand heute, 08:00<\/span>/,
  );
  expect(automation.indexOf("ai-message-data")).toBeGreaterThan(automation.indexOf("Bestätige den Kontostand"));
  expect(own).not.toContain("ai-message-data");
});

test("an automation Cloud could not name for this reader says only that an automation wrote, without a link", () => {
  const html = render([
    message(1, "user", "Briefing für Montag", {
      meta: { origin: { kind: "automation", id: "c_brief1", name: "Automation", named: false } },
    }),
  ]);
  const [automation = ""] = articles(html);
  expect(automation).toContain("Von einer Automation");
  expect(automation).not.toContain("„Automation“");
  expect(automation).not.toContain("<a ");
});

test("only the person's own message offers Edit and send again; one an automation or another chat wrote does not", () => {
  const html = render([
    message(1, "user", "Was steht heute an?", { meta: { origin: { kind: "person", id: "u1", name: "Lena Vogt" } } }),
    message(2, "user", "Briefing für Montag", {
      meta: { origin: { kind: "automation", id: "c_brief1", name: "Morgenbriefing", href: "/app/assistant/code/c_brief1" } },
    }),
    message(3, "user", "Bitte prüfe die Anzahlung", { meta: { origin: { kind: "chat", id: "c1", name: "Messe Köln" } } }),
    message(4, "user", "Review my open work.", {
      meta: { codeOrigin: { codeId: "c_morning", title: "Morning review", runId: "run", requestId: "request", label: "Started by Code" } },
    }),
  ]);
  const [own = "", automation = "", chat = "", code = ""] = articles(html);
  expect(own).toContain("Bearbeiten und neu senden");
  expect(own).toContain("ti-pencil");
  for (const foreign of [automation, chat, code]) {
    expect(foreign).not.toContain("Bearbeiten und neu senden");
    expect(foreign).not.toContain("ti-pencil");
  }
});

test("the source chip names when the message came, in the request's time zone, quietly after the source", () => {
  const withZone = (timeZone: string | undefined) =>
    renderToString(() =>
      createComponent(LocaleProvider, {
        locale: "de",
        get children() {
          return createComponent(AiChatActionsProvider, {
            actions: {},
            get children() {
              const timeline = createAiChatTimeline({
                messages: () => [
                  message(1, "user", "Briefing für Montag", {
                    meta: { origin: { kind: "automation", id: "c_brief1", name: "Morgenbriefing", href: "/app/assistant/code/c_brief1" } },
                    createdAt: "2026-11-09T06:00:00.000Z",
                  }),
                  message(2, "user", "Danke", { meta: { origin: { kind: "person", id: "u1", name: "Lena Vogt" } } }),
                ],
                activeTurn: () => null,
                ...(timeZone ? { timeZone } : {}),
              });
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
  const [automation = "", own = ""] = articles(withZone("Europe/Berlin"));
  // 06:00 UTC is 07:00 in Berlin; the server and the browser both use the request's zone, so both write the same time.
  expect(automation).toContain('<time datetime="2026-11-09T06:00:00.000Z">07:00</time>');
  expect(automation).toMatch(/<\/a><span class="ai-message-source__time"><span aria-hidden="true">·<\/span><time/);
  expect(articles(withZone("America/New_York"))[0]).toContain(">01:00</time>");
  // The person's own message has no chip, so no time either; without a known zone the chip names no time at all.
  expect(own).not.toContain("ai-message-source__time");
  expect(articles(withZone(undefined))[0]).not.toContain("ai-message-source__time");
});
