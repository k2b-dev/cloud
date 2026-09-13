import type { CodeApproval, CapabilityDecision } from "../artifacts/runtime/capabilities";
import type { AiStoredMessage, AiStreamSseEvent, AiTurnBlock } from "@k2b/cloud/ai";
import { CODE_RUNTIME_TOOL_NAMES, parseAiSse } from "@k2b/cloud/ai/browser";
import type { CloudCliContext } from "@k2b/cloud/cli";
import { cliCodeHost, closeCliCodeHost } from "./code-host";
import { printCapabilityTable } from "./capability-table";
import { AI_API, jsonRequest } from "./shared";

export type AssistantTurnStreamResult = {
  conversationId: string;
  turnId: string | null;
  status: "completed" | "failed" | "aborted" | "needs_attention" | "idle";
  error: string | null;
  text: string;
  messages: AiStoredMessage[];
  pending?: { type: "approval" | "client_tool"; callId: string; name: string };
};

const assistantText = (messages: AiStoredMessage[]): string => {
  let text = "";
  for (const stored of messages) {
    if (stored.message.role !== "assistant") continue;
    for (const part of stored.message.content) {
      if (typeof part !== "string" && part.type === "text") text += part.text;
    }
  }
  return text;
};

const isTerminalStatus = (status: string): status is "completed" | "failed" | "aborted" =>
  status === "completed" || status === "failed" || status === "aborted";

export const streamAssistantTurn = async (input: {
  ctx: CloudCliContext;
  conversationId: string;
  turnId?: string;
  initialResponse?: Response;
  approveTools?: readonly string[];
  onCapabilityApproval?:(request:CodeApproval)=>Promise<CapabilityDecision>;
  signal?: AbortSignal;
  onToolBlock?: (block: Extract<AiTurnBlock, { kind: "tool" }>) => void;
}): Promise<AssistantTurnStreamResult> => {
  const { ctx, conversationId } = input;
  const approvedTools = new Set(input.approveTools ?? []);
  const approvedCalls = new Set<string>();
  const executedCalls = new Set<string>();
  const abort = new AbortController();
  const onInterrupt = () => abort.abort();
  const onExternalAbort = () => abort.abort(input.signal?.reason);
  if (input.signal) input.signal.addEventListener("abort", onExternalAbort, { once: true });
  else process.once("SIGINT", onInterrupt);

  let targetTurnId = input.turnId ?? null;
  let initialResponse = input.initialResponse;
  let reconnectDelayMs = 250;
  let emittedText = "";
  const blocks = new Map<string, AiTurnBlock>();
  const emittedByBlock = new Map<string, string>();
  const renderedTables = new Set<string>();
  const emitTable = (callId: string, result: unknown) => {
    if (ctx.options.output !== "text" || renderedTables.has(callId)) return;
    if (printCapabilityTable(ctx, result)) renderedTables.add(callId);
  };

  const emitJsonLine = (value: Record<string, unknown>) => {
    if (ctx.options.output === "jsonl") ctx.jsonLine({ v: 1, conversationId, turnId: targetTurnId, ...value });
  };
  const emitTextBlock = (blockId: string, text: string) => {
    const previous = emittedByBlock.get(blockId) ?? "";
    if (!text.startsWith(previous)) return;
    const delta = text.slice(previous.length);
    if (!delta) return;
    emittedByBlock.set(blockId, text);
    emittedText += delta;
    if (ctx.options.output === "text") ctx.write(delta);
    emitJsonLine({ type: "text_delta", blockId, delta });
  };
  const finish = (result: AssistantTurnStreamResult): AssistantTurnStreamResult => {
    for (const stored of result.messages) {
      if (stored.message.role === "tool_result") emitTable(stored.message.callId, stored.message.result);
    }
    const text = result.text;
    if (ctx.options.output === "text") {
      if (text.startsWith(emittedText)) {
        const missing = text.slice(emittedText.length);
        if (missing) ctx.write(missing);
      }
      if (text || emittedText) ctx.write("\n");
    }
    return result;
  };

  const handleToolBlock = async (
    block: Extract<AiTurnBlock, { kind: "tool" }>,
    previous?: AiTurnBlock,
  ): Promise<AssistantTurnStreamResult | null> => {
    if (block.status === "completed") emitTable(block.callId, block.result);
    if (previous?.kind !== "tool" || previous.status !== block.status) {
      input.onToolBlock?.(block);
      emitJsonLine({ type: "tool", callId: block.callId, name: block.name, status: block.status });
      if (ctx.options.output === "text") ctx.error(`${block.name}: ${block.status.replaceAll("_", " ")}`);
    }
    if (block.status === "awaiting_approval") {
      if (approvedTools.has(block.name) && !approvedCalls.has(block.callId)) {
        approvedCalls.add(block.callId);
        await ctx.readJson(
          await ctx.fetch(
            `${AI_API}/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(targetTurnId!)}/actions/${encodeURIComponent(block.callId)}`,
            jsonRequest("POST", { type: "approval_response", approved: true }),
          ),
        );
        return null;
      }
      emitJsonLine({ type: "needs_attention", reason: "approval", callId: block.callId, name: block.name });
      return {
        conversationId,
        turnId: targetTurnId,
        status: "needs_attention",
        error: null,
        text: emittedText,
        messages: [],
        pending: { type: "approval", callId: block.callId, name: block.name },
      };
    }
    if (block.status === "awaiting_client" && CODE_RUNTIME_TOOL_NAMES.some(name => name === block.name)) {
      if (executedCalls.has(block.callId)) return null;
      executedCalls.add(block.callId);
      let result: unknown;
      try {
        result = await (await cliCodeHost(ctx,input.onCapabilityApproval ?? (async request=>{if(approvedTools.has(request.name))return {approved:true};throw new Error(`Capability ${request.name} requires approval; use interactive mode or --approve.`);} ))).call({ name: block.name, args: block.args, callId: block.callId, turnId: targetTurnId!, conversationId });
      } catch (error) { result = { error: error instanceof Error ? error.message : String(error), kind: "host", retryable: false }; }
      await ctx.readJson(await ctx.fetch(`${AI_API}/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(targetTurnId!)}/actions/${encodeURIComponent(block.callId)}`,
        jsonRequest("POST", {type:"tool_result",result})));
      return null;
    }
    if (block.status === "awaiting_client") {
      emitJsonLine({ type: "needs_attention", reason: "client_tool", callId: block.callId, name: block.name });
      return {
        conversationId,
        turnId: targetTurnId,
        status: "needs_attention",
        error: null,
        text: emittedText,
        messages: [],
        pending: { type: "client_tool", callId: block.callId, name: block.name },
      };
    }
    return null;
  };

  const handleEvent = async (event: AiStreamSseEvent): Promise<AssistantTurnStreamResult | null> => {
    if (event.type === "state") {
      if (!targetTurnId) {
        targetTurnId = event.activeTurn?.turnId ?? null;
        if (!targetTurnId) {
          return { conversationId, turnId: null, status: "idle", error: null, text: "", messages: [] };
        }
      }
      if (event.activeTurn?.turnId === targetTurnId) {
        for (const block of event.activeTurn.blocks) {
          const previous = blocks.get(block.id);
          blocks.set(block.id, block);
          if (block.kind === "text") emitTextBlock(block.id, block.text);
          if (block.kind === "tool") {
            const result = await handleToolBlock(block, previous);
            if (result) return result;
          }
        }
      } else {
        const messages = event.messages.filter((message) => message.loopId === targetTurnId);
        if (messages.length > 0) {
          const latestTurnId = event.messages.findLast(message => message.loopId)?.loopId;
          const failed = !event.activeTurn && latestTurnId === targetTurnId && event.conversation?.runStatus === "failed";
          return {
            conversationId,
            turnId: targetTurnId,
            status: failed ? "failed" : "completed",
            error: failed ? event.conversation.runError : null,
            text: assistantText(messages),
            messages,
          };
        }
      }
      return null;
    }

    if (event.turnId !== targetTurnId) return null;
    if (event.type === "turn_started") {
      emitJsonLine({ type: "turn_started", modelProfileId: event.modelProfileId, providerModel: event.providerModel });
      return null;
    }
    if (event.type === "block_delta") {
      const existing = blocks.get(event.blockId);
      const currentText = existing && (existing.kind === "text" || existing.kind === "thinking") ? existing.text : "";
      const block = { id: event.blockId, kind: event.blockKind, text: currentText + event.delta } as Extract<
        AiTurnBlock,
        { kind: "text" | "thinking" }
      >;
      blocks.set(event.blockId, block);
      if (event.blockKind === "text") emitTextBlock(event.blockId, block.text);
      else emitJsonLine({ type: "thinking_delta", blockId: event.blockId, delta: event.delta });
      return null;
    }
    if (event.type === "block_set") {
      const previous = blocks.get(event.block.id);
      blocks.set(event.block.id, event.block);
      if (event.block.kind === "text") emitTextBlock(event.block.id, event.block.text);
      if (event.block.kind !== "tool") return null;
      return handleToolBlock(event.block, previous);
    }

    const messages = event.messages ?? [];
    const result = {
      conversationId,
      turnId: targetTurnId,
      status: event.status,
      error: event.error,
      text: assistantText(messages),
      messages,
    } satisfies AssistantTurnStreamResult;
    emitJsonLine({ type: "turn_finished", status: result.status, error: result.error, text: result.text, messages });
    return result;
  };

  try {
    while (!abort.signal.aborted) {
      // Reopen the event stream periodically to reconcile durable state when
      // a completion notification is lost. This never cancels the code host.
      const connection = AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]);
      let response: Response;
      try {
        response = initialResponse ?? await ctx.fetch(`${AI_API}/conversations/${encodeURIComponent(conversationId)}/stream`, {
          headers: { Accept: "text/event-stream" },
          signal: connection,
        });
      } catch {
        if (abort.signal.aborted) break;
        await Bun.sleep(reconnectDelayMs);
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, 4_000);
        continue;
      }
      initialResponse = undefined;
      if (!response.ok || !response.body) await ctx.readJson(response);

      const events = parseAiSse(response, connection);
      try {
        while (!connection.aborted) {
          // Retry transport reads only. Never replay a failed approval or tool
          // result submission as if it were a dropped event connection.
          let next: IteratorResult<AiStreamSseEvent>;
          try { next = await events.next(); } catch (error) {
            if (error instanceof SyntaxError) throw error;
            break;
          }
          if (next.done) break;
          const event = next.value;
          const result = await handleEvent(event);
          if (result) {
            if (result.status !== "needs_attention") { abort.abort(); await closeCliCodeHost(ctx); }
            return finish(result);
          }
        }
      } finally {
        await events.return(undefined);
      }
      if (abort.signal.aborted) break;
      await Bun.sleep(reconnectDelayMs);
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 4_000);
    }
  } catch (error) {
    await closeCliCodeHost(ctx);
    throw error;
  } finally {
    if (abort.signal.aborted) await closeCliCodeHost(ctx);
    if (input.signal) input.signal.removeEventListener("abort", onExternalAbort);
    else process.removeListener("SIGINT", onInterrupt);
  }

  const status = "aborted" as const;
  const result = { conversationId, turnId: targetTurnId, status, error: "Streaming interrupted.", text: emittedText, messages: [] };
  if (isTerminalStatus(status)) emitJsonLine({ type: "turn_finished", status, error: result.error, text: result.text, messages: [] });
  return finish(result);
};
