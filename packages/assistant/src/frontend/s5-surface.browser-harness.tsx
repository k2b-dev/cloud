import type { AiStoredMessage } from "@k2b/cloud/ai";
import { AiChatActionsProvider, createAiChatTimeline } from "@k2b/cloud/ai/ui";
import { Chat, LocaleProvider } from "@k2b/ui";
import { createSignal, type JSX } from "solid-js";
import { render } from "solid-js/web";
import AssistantApprovalsView from "./AssistantApprovalsView";
import AssistantCodeView from "./AssistantCodeView";
import AssistantQueue, { type AssistantQueueEntry } from "./AssistantQueue";
import { FIXTURE_TIME_ZONE, myAppsFixture, waitingFixture } from "./code-overview.fixture";

// Automationen als Code v5, section 7, with fictional data: the card with its chat, Waiting for you with the
// automation, and a chat where an automation wrote with data and waits in the queue.
const query = new URLSearchParams(location.search);
const locale = query.get("lang") === "en" ? "en" : "de";
const scene = query.get("scene") ?? "chat";

const message = (seq: number, role: "user" | "assistant", text: string, meta: AiStoredMessage["meta"] = {}): AiStoredMessage => ({
  id: `m${seq}`,
  shortId: `m${seq}`,
  conversationId: "Brief1",
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
  meta,
  createdAt: `2026-11-14T0${Math.min(seq, 9)}:00:00.000Z`,
});
const automation = { kind: "automation" as const, id: "c_konto1", name: "Kontostand", href: "/app/assistant/code/c_konto1" };
const longData = Array.from({ length: 12 }, (_, index) => `Konto ${index + 1}: ${(4210.18 + index * 13).toFixed(2)} €`).join(" · ");
const MESSAGES: AiStoredMessage[] = [
  message(1, "user", "Was steht heute an?", { origin: { kind: "person", id: "u1", name: "Lena Vogt" } }),
  message(2, "assistant", "Heute stehen zwei Termine an."),
  message(3, "user", "Bestätige den Kontostand aus den Daten in einem Satz.", {
    origin: automation,
    sourceContext: "Geschäftskonto 4.210,18 € · Stand heute, 08:00",
  }),
  message(4, "assistant", "Kontostand heute um 08:00: 4.210,18 €."),
  message(5, "user", "Fasse die Kontostände in einem Satz zusammen.", { origin: automation, sourceContext: longData }),
  message(6, "assistant", "Alle zwölf Konten zusammen: 51.380,16 €."),
];
const [queueState, setQueueState] = createSignal<"pending" | "retrying" | "none">("pending");
const entries = (): AssistantQueueEntry[] =>
  queueState() === "none"
    ? []
    : [
        {
          id: "q1",
          text: "Mein Morgenbriefing: Termine, Angebote älter als eine Woche, unbeantwortete Kundenmails.",
          origin: { kind: "automation", id: "c_brief1", name: "Morgenbriefing", href: "/app/assistant/code/c_brief1" },
          // Cloud reports a start it retries by itself as failed with `dispatch_failed` and `retrying`.
          ...(queueState() === "retrying"
            ? { state: "failed" as const, error: "dispatch_failed", retrying: true }
            : { state: "pending" as const, error: null, retrying: false }),
          authorIsViewer: false,
        },
      ];
Object.assign(window, { setQueueState });

const ChatScene = (): JSX.Element => {
  const timeline = createAiChatTimeline({ messages: () => MESSAGES, activeTurn: () => null });
  return (
    <AiChatActionsProvider actions={{ onContinueTurn: () => {}, onRetryMessage: () => {} }}>
      <div style="max-width:48rem;margin:0 auto;padding:24px 16px">
        <Chat.Timeline items={timeline()} />
        <div id="queue-slot" style="position:relative;height:54px">
          <AssistantQueue
            entries={entries()}
            layout="line"
            sendingId={null}
            failedIds={new Set<string>()}
            busy={false}
            onSendNow={() => {}}
            onEdit={() => {}}
            onRemove={() => {}}
          />
        </div>
        <div id="following" style="height:40px" />
      </div>
    </AiChatActionsProvider>
  );
};

const Scene = (): JSX.Element => {
  if (scene === "apps-chat" || scene === "apps-chat-fehlt")
    return (
      <AssistantCodeView
        userId="fixture"
        timeZone={FIXTURE_TIME_ZONE}
        {...myAppsFixture(scene === "apps-chat" ? "chat" : "chat-fehlt")}
        onCreateInChat={() => {}}
      />
    );
  if (scene === "waiting") return <AssistantApprovalsView {...waitingFixture("automation")} />;
  return <ChatScene />;
};

render(
  () => (
    <LocaleProvider locale={locale}>
      <Scene />
    </LocaleProvider>
  ),
  document.getElementById("root")!,
);
Object.assign(window, { s5Ready: true });
