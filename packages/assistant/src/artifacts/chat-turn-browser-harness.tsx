import type { AiStoredMessage, AiStreamEvent, AiTurnBlock } from "@k2b/cloud/ai";
import { emptyProjection, reduceProjection, visibleMessages } from "@k2b/cloud/ai/solid";
import { AiChatActionsProvider, createAiChatTimeline } from "@k2b/cloud/ai/ui";
import { Chat } from "@k2b/ui";
import { createMemo } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import { render } from "solid-js/web";
import { ChatPresentation } from "./ChatPresentation";

// A scripted long Assistant turn: the browser test drives it step by step and measures where things stand.
type Tool = Extract<AiTurnBlock, { kind: "tool" }> & { args: Record<string, unknown> };
const user: AiStoredMessage = {
  id: "m1",
  shortId: "m1",
  conversationId: "abc234",
  seq: 1,
  kind: "message",
  message: {
    role: "user",
    content: [{ type: "text", text: "Build an inventory dashboard from these exports and mail the offer to Jana." }],
  },
  loopId: "turn1",
  modelProfileId: null,
  providerModel: null,
  usage: null,
  stopReason: null,
  loopAggregate: null,
  loopDoneReason: null,
  compactedAt: null,
  meta: null,
  createdAt: "2026-10-06T10:00:00.000Z",
};
const [state, setState] = createStore({ ...emptyProjection(), messages: [user] });
const emit = (event: AiStreamEvent) => setState(reconcile(reduceProjection(unwrap(state), event), { key: "id", merge: true }));
const base = { v: 1 as const, conversationId: "abc234", turnId: "turn1", attempt: 1 };
let seq = 0;
const next = () => ({ ...base, seq: ++seq });

const presentation = { presentationId: "00000000-0000-4000-8000-000000000001", title: "Inventory" };
const tool = (callId: string, name: string, patch: Partial<Tool> = {}): Tool => ({
  id: `tool-${callId}`,
  kind: "tool",
  callId,
  name,
  status: "completed",
  args: {},
  result: {},
  ...patch,
});
const mailPresentation = {
  kind: "capability" as const,
  appId: "mail",
  appName: "Mail",
  appIcon: "ti ti-mail",
  title: "Send email",
  capabilityKind: "action" as const,
};
const mail = tool("mail", "mail__action__send", {
  args: { to: "jana.berger@example.com", subject: "Offer" },
  presentation: mailPresentation,
});
const sent = { summary: "Email to Jana Berger sent", links: [{ rel: "open", href: "/app/mail/message/1", title: "View" }] };
const reads = ["orders-q1.csv", "orders-q2.csv", "orders-q3.csv"].map((name, index) =>
  tool(`read${index}`, "read_file", { args: { path: `/${name}` } }),
);
const csv = tool("csv", "present", {
  args: { path: "/orders-joined.csv" },
  result: { path: "/orders-joined.csv", size: 1_800_000, mediaType: "text/csv" },
});
const view = tool("view", "code_present", { args: { runId: "run", title: "Inventory" } });
const texts = {
  first: "I read the four files first.",
  second: "The data is clean. Now I build the dashboard.",
  final: "**Inventory is ready.** 20 items are available and 4 are in maintenance.",
};

const call = (block: Tool) => ({ type: "tool_call" as const, id: block.callId, name: block.name, args: block.args });
const toolResult = (block: Tool, value: unknown) => ({
  role: "tool_result" as const,
  callId: block.callId,
  name: block.name,
  result: value,
  isError: false,
});
const stored = (index: number, value: AiStoredMessage["message"], patch: Partial<AiStoredMessage> = {}): AiStoredMessage => ({
  id: `m${index}`,
  shortId: `m${index}`,
  conversationId: "abc234",
  seq: index,
  kind: "message",
  message: value,
  loopId: "turn1",
  modelProfileId: "model",
  providerModel: "model",
  usage: null,
  stopReason: null,
  loopAggregate: null,
  loopDoneReason: null,
  compactedAt: null,
  meta: null,
  createdAt: "2026-10-06T10:00:00.000Z",
  ...patch,
});

/** Ends the turn the way the server does: the saved messages replace the live blocks. A stop leaves the approval unanswered. */
const finish = (status: "completed" | "aborted") => {
  const end = "2026-10-06T10:03:05.000Z";
  const history = [
    stored(2, { role: "assistant", content: [{ type: "text", text: texts.first }, ...reads.map(call), call(csv)] }),
    ...reads.map((read, index) => stored(3 + index, toolResult(read, {}))),
    stored(6, toolResult(csv, csv.result)),
    stored(7, { role: "assistant", content: [{ type: "text", text: texts.second }, call(view)] }),
    stored(8, toolResult(view, presentation)),
    stored(
      9,
      { role: "assistant", content: [call(mail)] },
      {
        meta: { toolPresentations: { mail: mailPresentation } },
        ...(status === "aborted" ? { loopDoneReason: "aborted" as const, createdAt: end } : {}),
      },
    ),
    ...(status === "completed"
      ? [
          stored(10, toolResult(mail, sent)),
          stored(11, { role: "assistant", content: [{ type: "text", text: texts.final }] }, { loopDoneReason: "stop", createdAt: end }),
        ]
      : []),
  ];
  emit({ ...next(), type: "turn_finished", status, error: null, messages: history });
};

const steps: Record<string, () => void> = {
  start: () => {
    emit({ ...next(), type: "turn_started", modelProfileId: "model", providerModel: "model", blocks: [] });
    emit({ ...next(), type: "block_delta", blockId: "a1-t0-0", blockKind: "text", delta: texts.first });
    for (const read of reads) emit({ ...next(), type: "block_set", block: read });
    emit({ ...next(), type: "block_set", block: csv });
    emit({ ...next(), type: "block_delta", blockId: "a1-t1-0", blockKind: "text", delta: texts.second });
    emit({ ...next(), type: "block_set", block: { ...view, status: "running", result: undefined } });
  },
  present: () => emit({ ...next(), type: "block_set", block: { ...view, result: presentation } }),
  approval: () =>
    emit({
      ...next(),
      type: "block_set",
      block: { ...mail, status: "awaiting_approval", result: undefined, approval: { allowAlways: false } },
    }),
  answer: () => emit({ ...next(), type: "block_delta", blockId: "a1-t3-0", blockKind: "text", delta: texts.final }),
  finish: () => finish("completed"),
  stop: () => finish("aborted"),
};

function Harness() {
  return (
    <AiChatActionsProvider
      actions={{
        renderCodePresentation: (result) => (
          <ChatPresentation result={result()} conversationId="abc234" httpHost={{ approve: async () => false }} />
        ),
        onApproval: async (_request, input) => {
          // The server resumes the turn: the action runs and returns its receipt.
          setTimeout(() => {
            emit({ ...next(), type: "block_set", block: { ...mail, status: input.approved ? "running" : "rejected", result: undefined } });
            if (input.approved) setTimeout(() => emit({ ...next(), type: "block_set", block: { ...mail, result: sent } }), 50);
          }, 20);
        },
        fileUrl: (path) => `/files${path}`,
      }}
    >
      {(() => {
        const items = createAiChatTimeline({ messages: createMemo(() => visibleMessages(state)), activeTurn: () => state.activeTurn });
        return (
          <Chat class="harness-chat">
            <Chat.Timeline items={items()} conversationKey="abc234" scrollFade={false} />
          </Chat>
        );
      })()}
    </AiChatActionsProvider>
  );
}

Object.assign(window, { turn: steps });
render(() => <Harness />, document.getElementById("root")!);
