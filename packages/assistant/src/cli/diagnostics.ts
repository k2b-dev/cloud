import type { AiConversation, AiStoredMessage } from "@valentinkolb/cloud/ai";

type DiagnosticMessageEvent = {
  type: "user" | "assistant" | "summary";
  seq: number;
  at: string;
  content: unknown;
};

type DiagnosticToolEvent = {
  type: "tool";
  callId: string;
  name: string;
  callSeq: number | null;
  resultSeq: number | null;
  requestedAt: string | null;
  completedAt: string | null;
  status: "pending" | "completed" | "failed";
  args?: unknown;
  result?: unknown;
};

type DiagnosticEvent = DiagnosticMessageEvent | DiagnosticToolEvent;

type DiagnosticTurn = {
  loopId: string | null;
  startedAt: string;
  completedAt: string;
  modelProfiles: string[];
  providerModels: string[];
  events: DiagnosticEvent[];
  outcome: Record<string, unknown> | null;
};

export type AssistantChatDiagnostic = {
  version: 1;
  chat: {
    id: string;
    title: string;
    status: AiConversation["runStatus"];
    projectId: string | null;
    createdAt: string;
    updatedAt: string;
  };
  turns: DiagnosticTurn[];
};

type DiagnosticInput = {
  conversation: Pick<AiConversation, "id" | "title" | "runStatus" | "projectId" | "createdAt" | "updatedAt">;
  messages: readonly AiStoredMessage[];
};

const compactOutcome = (message: AiStoredMessage): Record<string, unknown> | null => {
  if (!message.loopAggregate) return null;
  return Object.fromEntries(Object.entries(message.loopAggregate).filter(([key]) => key !== "turns"));
};

const diagnosticGroupKey = (message: AiStoredMessage): string => message.loopId ?? `message:${message.seq}`;

/** Build a compact, lossless-for-tools view of one authorized chat detail. */
export const buildAssistantChatDiagnostic = (input: DiagnosticInput): AssistantChatDiagnostic => {
  const groups = new Map<string, AiStoredMessage[]>();
  for (const message of input.messages) {
    const key = diagnosticGroupKey(message);
    const group = groups.get(key) ?? [];
    group.push(message);
    groups.set(key, group);
  }

  const turns = [...groups.values()].map((messages): DiagnosticTurn => {
    const events: DiagnosticEvent[] = [];
    const toolsByCallId = new Map<string, DiagnosticToolEvent>();
    const modelProfiles = new Set<string>();
    const providerModels = new Set<string>();

    for (const stored of messages) {
      if (stored.modelProfileId) modelProfiles.add(stored.modelProfileId);
      if (stored.providerModel) providerModels.add(stored.providerModel);

      if (stored.kind === "summary") {
        events.push({ type: "summary", seq: stored.seq, at: stored.createdAt, content: stored.message });
        continue;
      }
      if (stored.message.role === "tool_result") {
        const existing = toolsByCallId.get(stored.message.callId);
        if (existing) {
          existing.resultSeq = stored.seq;
          existing.completedAt = stored.createdAt;
          existing.status = stored.message.isError ? "failed" : "completed";
          existing.result = stored.message.result;
        } else {
          const event: DiagnosticToolEvent = {
            type: "tool",
            callId: stored.message.callId,
            name: stored.message.name,
            callSeq: null,
            resultSeq: stored.seq,
            requestedAt: null,
            completedAt: stored.createdAt,
            status: stored.message.isError ? "failed" : "completed",
            result: stored.message.result,
          };
          events.push(event);
          toolsByCallId.set(event.callId, event);
        }
        continue;
      }
      if (stored.message.role === "user") {
        events.push({ type: "user", seq: stored.seq, at: stored.createdAt, content: stored.message.content });
        continue;
      }

      let assistantContent: unknown[] = [];
      const flushAssistantContent = () => {
        if (assistantContent.length === 0) return;
        events.push({ type: "assistant", seq: stored.seq, at: stored.createdAt, content: assistantContent });
        assistantContent = [];
      };
      for (const part of stored.message.content) {
        if (typeof part !== "string" && part.type === "tool_call") {
          flushAssistantContent();
          const event: DiagnosticToolEvent = {
            type: "tool",
            callId: part.id,
            name: part.name,
            callSeq: stored.seq,
            resultSeq: null,
            requestedAt: stored.createdAt,
            completedAt: null,
            status: "pending",
            args: part.args,
          };
          events.push(event);
          toolsByCallId.set(event.callId, event);
        } else {
          assistantContent.push(part);
        }
      }
      flushAssistantContent();
    }

    const first = messages[0]!;
    const last = messages.at(-1)!;
    const aggregateMessage = messages.findLast((message) => message.loopAggregate !== null);
    return {
      loopId: first.loopId,
      startedAt: first.createdAt,
      completedAt: last.createdAt,
      modelProfiles: [...modelProfiles],
      providerModels: [...providerModels],
      events,
      outcome: aggregateMessage ? compactOutcome(aggregateMessage) : null,
    };
  });

  return {
    version: 1,
    chat: {
      id: input.conversation.id,
      title: input.conversation.title,
      status: input.conversation.runStatus,
      projectId: input.conversation.projectId,
      createdAt: input.conversation.createdAt,
      updatedAt: input.conversation.updatedAt,
    },
    turns,
  };
};
