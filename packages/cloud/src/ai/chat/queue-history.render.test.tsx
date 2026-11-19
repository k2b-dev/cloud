import { expect, test } from "bun:test";
import "../../../../ui/test/solid-ssr-preload";
import { Chat, LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { AiStoredMessage } from "../types";
import type { AiChatActions } from "./message-actions";

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

const render = (messages: AiStoredMessage[], locale = "de", timeZone = "UTC", extra: Partial<AiChatActions> = {}) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(AiChatActionsProvider, {
          actions: { onContinueTurn: () => {}, onRetryMessage: () => {}, ...extra },
          get children() {
            const timeline = createAiChatTimeline({ messages: () => messages, activeTurn: () => null, timeZone });
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

test.each([
  { locale: "de", name: "Wecker" },
  { locale: "en", name: "Alarm" },
])("an alarm message keeps its note and a quiet chip with its planned time in $locale", ({ locale, name }) => {
  const html = render(
    [
      message(1, "user", "Prüfe die Anzahlung", {
        createdAt: "2026-11-18T15:00:40.000Z",
        meta: { origin: { kind: "wakeup", id: "alarm1", name, scheduledAt: "2026-11-18T15:00:00.000Z" } },
      }),
    ],
    locale,
    "Europe/Berlin",
  );
  const [alarm] = articles(html);
  const text = alarm?.replace(/<[^>]*>/g, "");
  expect(alarm).toContain("Prüfe die Anzahlung");
  expect(alarm).toContain("data-source");
  expect(alarm).toContain('class="ai-message-source__icon ti ti-alarm"');
  expect(alarm).toContain('data-kind="wakeup" aria-hidden="true"');
  expect(text).toContain(`${name} · 16:00`);
  expect(text).not.toContain("18:00");
  expect(alarm).not.toContain("<a ");
  expect(alarm).not.toContain("Chat „");
  expect(alarm).not.toContain("Automation");
});

test("an alarm chip names a delivery well after its planned time as delayed, and a repeating alarm by its rhythm", () => {
  const origin = { kind: "wakeup" as const, id: "alarm1", name: "Wecker", scheduledAt: "2026-11-18T15:00:00.000Z" };
  const late = articles(
    render([message(1, "user", "Prüfe die Anzahlung", { createdAt: "2026-11-18T15:42:00.000Z", meta: { origin } })], "de", "Europe/Berlin"),
  );
  expect(late[0]?.replace(/<[^>]*>/g, "")).toContain("Wecker · geplant 16:00, verspätet");
  // An alarm's message is no message of the person's own: it offers no "Edit".
  expect(late[0]).not.toContain("Bearbeiten und neu senden");
  // Alarm facts carry the alarm: a repeating one shows its rhythm in words, never cron, and the sign for repeating.
  const wakeup = {
    id: "alarm1",
    at: "2026-11-19T07:00:00.000Z",
    cron: "0 8 * * 1-5",
    timezone: "Europe/Berlin",
    endsAt: "2026-12-16T10:00:00.000Z",
    note: "Posteingang zusammenfassen",
    noteSource: { kind: "person" as const, userId: "u1" },
    snoozes: 0,
    status: "active" as const,
    missedReason: null,
    revision: 0,
    // The turn that set it wrote English words; the German reader still reads German.
    rhythm: "Mon–Fri 08:00",
  };
  const repeating = render(
    [
      message(1, "assistant", "Wecker gestellt", {
        loopId: null,
        meta: { wakeupEvent: { id: "e1", kind: "created", at: "2026-11-18T07:00:00.000Z", wakeup } },
      }),
      message(2, "user", "Posteingang zusammenfassen", {
        createdAt: "2026-11-18T07:00:20.000Z",
        meta: { origin: { ...origin, scheduledAt: "2026-11-18T07:00:00.000Z" } },
      }),
    ],
    "de",
    "Europe/Berlin",
  );
  expect(repeating.replace(/<[^>]*>/g, "")).toContain("Wecker · Mo–Fr 08:00");
  expect(repeating).toContain('class="ai-message-source__icon ti ti-repeat"');
  // Without a host that draws alarm lines, the fact stands quietly as Cloud stored it.
  expect(repeating).toContain("Wecker gestellt");
  expect(repeating).not.toContain("0 8 * * 1-5");
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
  expect(automation).toMatch(/<\/a><time class="ai-message-source__time" datetime="2026-11-09T06:00:00.000Z">07:00<\/time>/);
  expect(articles(withZone("America/New_York"))[0]).toContain(">01:00</time>");
  // The person's own message has no chip, so no time either; without a known zone the chip names no time at all.
  expect(own).not.toContain("ai-message-source__time");
  expect(articles(withZone(undefined))[0]).not.toContain("ai-message-source__time");
});

test("an alarm Gustav could not set at the limit of five says Limit reached in its work line and offers no Try again", () => {
  const turn = (seq: number, message: AiStoredMessage["message"]): AiStoredMessage => ({ ...message_(seq), message, loopId: "turn9" });
  const message_ = (seq: number) => message(seq, "assistant", "");
  const tried = { at: "2026-11-20T09:00:00.000Z", timezone: "Europe/Berlin", note: "Reisekosten" };
  const history = (result: string) => [
    { ...message(1, "user", "Erinnere mich Freitag um 10 an die Reisekosten."), loopId: "turn9" },
    turn(2, { role: "assistant", content: [{ type: "tool_call", id: "call1", name: "wakeup_create", args: tried }] }),
    turn(3, { role: "tool_result", callId: "call1", name: "wakeup_create", result, isError: true }),
    turn(4, {
      role: "assistant",
      content: [{ type: "text", text: "In diesem Chat sind schon 5 Wecker gestellt. Soll ich einen ändern oder löschen?" }],
    }),
  ];
  const drawn: string[] = [];
  const host = {
    renderWakeupLine: (line: Parameters<NonNullable<AiChatActions["renderWakeupLine"]>>[0]) => {
      drawn.push(line.failed ? "failed" : "fact");
      return createComponent(() => "Erneut versuchen", {});
    },
  };
  const limit = render(
    history("LIMIT_REACHED: This chat already has five alarms. Change or delete one first."),
    "de",
    "Europe/Berlin",
    host,
  );
  expect(limit).toContain("Grenze erreicht");
  expect(limit).not.toContain("fehlgeschlagen");
  expect(drawn).toEqual([]);
  // Any other failure keeps its quiet line with Try again.
  const other = render(history("Choose a future time."), "de", "Europe/Berlin", host);
  expect(other).toContain("1 fehlgeschlagen");
  expect(drawn).toEqual(["failed"]);
});
