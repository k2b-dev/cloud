import type { CompactEvent, NessiLoop, OutboundEvent, Provider, Tool, ToolResolver } from "@k2b/nessi";
import { compact, nessi } from "@k2b/nessi";
import { loadCurrentHelp } from "../_internal/help-catalog";
import { listCapabilities } from "../_internal/registry";
import type { CapabilityActionReview } from "../contracts/capabilities";
import type { AccessSubject, RequestActor } from "../server";
import { logger } from "../services/logging";
import { coreSettings } from "../services/settings/api";
import { normalizeLocale } from "../shared/locale";
import { type AiToolApprovalContext, aiToolAllowsAlways, aiToolApprovalScope, hasRememberedAiToolApproval } from "./approvals";
import { createAiToolResolver } from "./capabilities";
import { executeAiCapability, resolveAiCapabilityActor, reviewAiCapability } from "./capability-execution";
import { createCloudCompactFn } from "./compaction";
import { createCloudAiLocalBashTool, createConfiguredDefaultCloudAiTools } from "./default-tools";
import { aiFileStore } from "./files-store";
import { aiMemories } from "./memories";
import { createCloudAiMemoryTool } from "./memory-tool";
import { recordAiMemoryWorkflowEvidence } from "./memory-workflow-evidence";
import { type AiUserPrefs, aiActorUser, aiUserPrefs } from "./prefs";
import { createCloudAiReadProjectKnowledgeTool, createCloudAiSearchProjectTool } from "./project-tool";
import { aiProjects } from "./projects";
import {
  type AiTurnBlock,
  type AiWireEvent,
  applyWireEventToBlocks,
  buildBlocksFromMessages,
  compactionBlockId,
  reconcileResolvedTurnActions,
  steerAppliedBlockId,
  steerMessageBlockId,
  streamBlockId,
  toolBlockId,
} from "./protocol";
import { collectConversationResourceObservations } from "./resource-refs";
import { isAiVisionModelConfigured, type resolveAiModel } from "./settings";
import { selectAiSkillCatalog } from "./skill-catalog";
import { createCloudAiLoadSkillTool, createCloudAiSearchSkillsTool } from "./skill-tool";
import { aiSkills } from "./skills";
import { aiConversations } from "./store";
import { publishAiWireEvent } from "./stream";
import { composeAiSystemPrompt } from "./system-prompt";
import { aiToolAudit } from "./tool-audit";
import { resolveAiToolResultMaxChars } from "./tool-result-budget";
import { aiToolPromptHints, type PreparedAiTools, prepareAiTools } from "./tools";
import type {
  AiChatTurnRunConfig,
  AiFrontendToolMode,
  AiPendingTurnActionRecord,
  AiRuntimeTool,
  AiStoredMessage,
  AiToolPresentation,
  AiTurnClaim,
  AiTurnFinalizedEvent,
  AiTurnRunConfig,
  AiTurnSteer,
} from "./types";
import { isAiImageMediaType } from "./types";
import { validateAiTurnRequest } from "./validate";

const log = logger("ai:executor");

const AI_TURN_LEASE_MS = 45_000;
const AI_COALESCE_MS = 25;
const AI_COALESCE_MAX_CHARS = 512;
const AI_SNAPSHOT_INTERVAL_MS = 1_000;
const AI_ACTION_BUDGET_MS = 24 * 60 * 60_000;
const AI_FINAL_TOOL_ROUND_PROMPT = `# Final response
The configured tool-round budget has been reached, so no more tools are available in this turn. Answer the user's request now with the best result supported by the evidence already gathered. State any material uncertainty or incomplete part clearly.`;

const toolRoundState = (messages: AiStoredMessage[]): { issued: number; completed: number } => {
  const completedCallIds = new Set(messages.flatMap(({ message }) => (message.role === "tool_result" ? [message.callId] : [])));
  const rounds = messages.flatMap(({ message }) => {
    if (message.role !== "assistant") return [];
    const callIds = message.content.flatMap((block) => (block.type === "tool_call" ? [block.id] : []));
    return callIds.length > 0 ? [callIds] : [];
  });
  return {
    issued: rounds.length,
    completed: rounds.filter((callIds) => callIds.every((callId) => completedCallIds.has(callId))).length,
  };
};

const applyToolRoundPolicy = (input: {
  provider: Provider;
  tools: Tool[] | ToolResolver;
  maxToolRounds?: number;
  issuedToolRounds: number;
  completedToolRounds: number;
}): { provider: Provider; tools: Tool[] | ToolResolver; maxTurns?: number; noteToolRound: () => void } => {
  const limit = Math.floor(input.maxToolRounds ?? 0);
  if (limit <= 0) return { provider: input.provider, tools: input.tools, noteToolRound: () => undefined };

  const issuedAtStart = Math.max(0, Math.floor(input.issuedToolRounds));
  let completed = Math.max(0, Math.floor(input.completedToolRounds));
  let finalSynthesis = completed >= limit;
  const tools: ToolResolver = async () => {
    finalSynthesis = completed >= limit;
    if (finalSynthesis) return [];
    return typeof input.tools === "function" ? input.tools() : input.tools;
  };
  const provider: Provider = {
    name: input.provider.name,
    family: input.provider.family,
    model: input.provider.model,
    contextWindow: input.provider.contextWindow,
    capabilities: input.provider.capabilities,
    complete: (request) => input.provider.complete(request),
    stream: async function* (request) {
      yield* input.provider.stream(
        finalSynthesis ? { ...request, systemPrompt: `${request.systemPrompt ?? ""}\n\n${AI_FINAL_TOOL_ROUND_PROMPT}`.trim() } : request,
      );
    },
  };

  // Nessi checks this before provider calls. The extra round is the tool-free
  // synthesis call after the last allowed tool-using round.
  return {
    provider,
    tools,
    maxTurns: Math.max(1, limit - issuedAtStart + 1),
    noteToolRound: () => {
      completed += 1;
    },
  };
};

const indexConversationResources = async (input: Parameters<typeof aiConversations.indexConversationResources>[0]): Promise<void> => {
  try {
    await aiConversations.indexConversationResources(input);
  } catch (error) {
    log.warn("Failed to index AI conversation resources", {
      conversationId: input.conversationId,
      turnId: input.turnId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const recordMemoryWorkflowEvidence = async (input: Parameters<typeof recordAiMemoryWorkflowEvidence>[0]): Promise<void> => {
  try {
    await recordAiMemoryWorkflowEvidence(input);
  } catch (error) {
    log.warn("Failed to record AI workflow evidence", {
      conversationId: input.conversationId,
      turnId: input.turnId,
      capabilityId: input.capabilityId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const indexConversationToolSource = async (input: {
  conversationId: string;
  turnId: string;
  callId: string;
  name: string;
  result: unknown;
  isError: boolean;
}): Promise<void> => {
  if (input.isError) return;
  try {
    let source: Parameters<typeof aiConversations.indexConversationSource>[0]["source"] | null = null;
    if (input.name === "web_search") {
      source = { kind: "activity", key: "web_search", title: "Web search", preview: "Searched the web", icon: "ti ti-world" };
    } else if (input.name === "web_extract" && typeof input.result === "object" && input.result !== null) {
      const result = input.result as Record<string, unknown>;
      if (typeof result.url === "string" && result.url.trim()) {
        const url = new URL(result.url);
        url.hash = "";
        source = {
          kind: "web",
          key: url.href,
          title: typeof result.title === "string" && result.title.trim() ? result.title.trim() : url.hostname,
          preview: typeof result.description === "string" ? result.description.trim().slice(0, 500) : undefined,
          icon: "ti ti-world",
          href: url.href,
        };
      }
    }
    if (!source) return;
    await aiConversations.indexConversationSource({
      conversationId: input.conversationId,
      turnId: input.turnId,
      callId: input.callId,
      source,
    });
  } catch (error) {
    log.warn("Failed to index AI conversation source", {
      conversationId: input.conversationId,
      turnId: input.turnId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const memoryQueryFromInput = (input: unknown): string => {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";
  return input
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part !== "object" || part === null || !("type" in part)) return "";
      return part.type === "text" && "text" in part && typeof part.text === "string" ? part.text : "";
    })
    .join(" ")
    .trim();
};

const accessSubjectForActor = (actor: RequestActor | undefined): AccessSubject | null => {
  if (!actor) return null;
  if (actor.kind === "user") return { type: "user", userId: actor.user.id };
  if (actor.delegatedUser) {
    return { type: "user", userId: actor.delegatedUser.id, delegatedByServiceAccountId: actor.serviceAccount.id };
  }
  return { type: "service_account", serviceAccountId: actor.serviceAccount.id };
};

export type ExecutorConfig = {
  leaseOwner: string;
  heartbeatMs: number;
  /** Re-enqueue continuation work after a suspension so any worker can resume it. */
  enqueueContinuation: (input: { conversationId: string; turnId: string }) => Promise<void>;
  /** Settings/model resolution seam — tests inject a fake so they never touch shared settings. */
  validateTurn?: typeof validateAiTurnRequest;
  /** Runs after the durable turn state and final wire event are flushed. */
  onTurnFinalized?: (event: AiTurnFinalizedEvent) => Promise<void>;
};

type ResolvedModel = Awaited<ReturnType<typeof resolveAiModel>>;
type ValidatedTurn = { settings: Awaited<ReturnType<typeof validateAiTurnRequest>>["settings"]; resolved: ResolvedModel };

// ---------------------------------------------------------------------------
// Baseline rebuild — reconstruct the full active-turn view from persisted rounds
// ---------------------------------------------------------------------------

const rebuildBlocksFromMessages = (
  messages: AiStoredMessage[],
  pending: AiPendingTurnActionRecord[],
  steers: AiTurnSteer[] = [],
): AiTurnBlock[] => {
  const blocks = buildBlocksFromMessages(messages);
  const indexByCallId = new Map(blocks.map((block, index) => [block.kind === "tool" ? block.callId : `_${index}`, index]));

  for (const action of pending) {
    const parentCallId = action.kind === "custom_approval" ? customApprovalParentCallId(action.callId) : undefined;
    const at = indexByCallId.get(action.callId) ?? (parentCallId ? indexByCallId.get(parentCallId) : undefined);
    const existing = at !== undefined ? blocks[at] : undefined;
    if (existing?.kind === "tool") {
      blocks[at!] = {
        ...existing,
        callId: action.callId,
        status: action.kind === "client_tool" ? "awaiting_client" : "awaiting_approval",
        approval:
          action.kind === "client_tool" ? undefined : { message: action.message, review: action.review, allowAlways: action.allowAlways },
        frontendMode: action.frontendMode,
      };
    }
  }

  const known = new Set(blocks.map((block) => block.id));
  for (const steer of steers) {
    if (steer.status === "discarded" || known.has(steerMessageBlockId(steer.id))) continue;
    blocks.push({
      id: steerMessageBlockId(steer.id),
      kind: "steer_message",
      steerId: steer.id,
      text: steer.text,
      status: steer.status === "pending" ? "pending" : "consumed",
    });
  }

  return blocks;
};

type ChatAttemptState = {
  loopMessages: AiStoredMessage[];
  pendingRecords: AiPendingTurnActionRecord[];
  resolvedRecords: AiPendingTurnActionRecord[];
  turnSteers: AiTurnSteer[];
};

const rebuildAttemptBaseline = (state: ChatAttemptState): AiTurnBlock[] => {
  const persisted = rebuildBlocksFromMessages(state.loopMessages, state.pendingRecords, state.turnSteers);
  const unresolvedCallIds = new Set(
    persisted.flatMap((block) => (block.kind === "tool" && block.status === "running" ? [block.callId] : [])),
  );
  const unreflectedResolvedRecords = state.resolvedRecords.filter((action) => {
    if (unresolvedCallIds.has(action.callId)) return true;
    const parentCallId = action.kind === "custom_approval" ? customApprovalParentCallId(action.callId) : undefined;
    return parentCallId ? unresolvedCallIds.has(parentCallId) : false;
  });
  if (unreflectedResolvedRecords.length === 0) return persisted;
  return reconcileResolvedTurnActions(
    rebuildBlocksFromMessages(state.loopMessages, [...state.pendingRecords, ...unreflectedResolvedRecords], state.turnSteers),
    unreflectedResolvedRecords,
  );
};

const loadChatAttemptState = async (conversationId: string, turnId: string): Promise<ChatAttemptState> => {
  const [loopMessages, pendingRecords, resolvedRecords, turnSteers] = await Promise.all([
    aiConversations.listTurnMessages({ conversationId, loopId: turnId }),
    aiConversations.listPendingActionRecords({ conversationId, turnId }),
    aiConversations.listResolvedPendingActions({ conversationId, turnId }),
    aiConversations.listTurnSteers({ conversationId, turnId }),
  ]);
  return { loopMessages, pendingRecords, resolvedRecords, turnSteers };
};

// ---------------------------------------------------------------------------
// Event mapper — Nessi block/tool events to Cloud wire block ops
// ---------------------------------------------------------------------------

type BlockSetOp = { type: "block_set"; block: AiTurnBlock };
type BlockDeltaOp = { type: "block_delta"; blockId: string; blockKind: "text" | "thinking"; delta: string };
type BlockOp = BlockSetOp | BlockDeltaOp;

type ToolBlockPatch = Partial<Extract<AiTurnBlock, { kind: "tool" }>> & { name?: string; clearApproval?: boolean };

const customApprovalParentCallId = (callId: string): string | undefined => /^(.*)-approval-\d+$/.exec(callId)?.[1];

const approvalReviewForCallId = (
  reviews: ReadonlyMap<string, CapabilityActionReview>,
  callId: string,
): CapabilityActionReview | undefined => {
  const direct = reviews.get(callId);
  if (direct) return direct;
  const parentCallId = customApprovalParentCallId(callId);
  return parentCallId ? reviews.get(parentCallId) : undefined;
};

/**
 * Map nessi's canonical block/tool events to Cloud wire ops. nessi owns block
 * structure and whitespace hygiene; the mapper only (a) scopes stream block ids
 * to (attempt, turn) so re-claimed attempts never collide, and (b) maintains
 * tool blocks keyed by callId, enriched with Cloud status/approval metadata.
 */
const createEventMapper = (attempt: number, seedBlocks: AiTurnBlock[]) => {
  const toolBlocks = new Map<string, Extract<AiTurnBlock, { kind: "tool" }>>();
  for (const block of seedBlocks) {
    if (block.kind === "tool") toolBlocks.set(block.callId, block);
  }
  /** Real frontend mode per tool name — set once the turn's tools are prepared.
   *  Getting this wrong is not cosmetic: the client auto-resolves plain "client"
   *  blocks, so a mislabeled client_interaction tool (survey) would be answered
   *  with a fake result before the user ever sees it. */
  let frontendModes = new Map<string, AiFrontendToolMode>();
  const setFrontendModes = (modes: Map<string, AiFrontendToolMode>) => {
    frontendModes = modes;
  };
  let presentations = new Map<string, AiToolPresentation>();
  const setPresentations = (items: Map<string, AiToolPresentation>) => {
    presentations = items;
  };
  let canonicalNames = new Map<string, string>();
  const setCanonicalNames = (items: Map<string, string>) => {
    canonicalNames = items;
  };
  let approvalReviews = new Map<string, CapabilityActionReview>();
  const setApprovalReviews = (items: Map<string, CapabilityActionReview>) => {
    approvalReviews = items;
  };
  let approvalPolicies: PreparedAiTools["approvalPolicies"] = new Map();
  const setApprovalPolicies = (items: PreparedAiTools["approvalPolicies"]) => {
    approvalPolicies = items;
  };
  let rejectedCallIds = new Set<string>();
  const setRejectedCallIds = (items: Set<string>) => {
    rejectedCallIds = items;
  };
  /** nessi stream block ids (turn-scoped) that belong to tool_call blocks — their deltas are raw args JSON. */
  const toolStreamIds = new Set<string>();
  /** kind per open Cloud stream block id, for delta create-if-missing. */
  const streamKinds = new Map<string, "text" | "thinking">();

  const setTool = (callId: string, patch: ToolBlockPatch, displayCallId = callId): BlockOp => {
    const existing = toolBlocks.get(callId);
    const rawName = patch.name ?? existing?.name ?? "tool";
    const name = canonicalNames.get(rawName) ?? rawName;
    const block: Extract<AiTurnBlock, { kind: "tool" }> = {
      id: toolBlockId(displayCallId),
      kind: "tool",
      callId,
      name,
      args: "args" in patch ? patch.args : existing?.args,
      status: patch.status ?? existing?.status ?? "running",
      result: "result" in patch ? patch.result : existing?.result,
      isError: "isError" in patch ? patch.isError : existing?.isError,
      approval: patch.clearApproval ? undefined : "approval" in patch ? patch.approval : existing?.approval,
      frontendMode: patch.frontendMode ?? existing?.frontendMode,
      presentation: patch.presentation ?? existing?.presentation ?? presentations.get(rawName) ?? presentations.get(name),
    };
    toolBlocks.set(callId, block);
    return { type: "block_set", block };
  };

  const compaction = (
    status: "running" | "completed" | "failed",
    result?: Extract<AiTurnBlock, { kind: "compaction" }>["result"],
  ): BlockOp => ({
    type: "block_set",
    block: { id: compactionBlockId, kind: "compaction", status, ...(result ? { result } : {}) },
  });

  const translate = (event: OutboundEvent): BlockOp[] => {
    switch (event.type) {
      case "block_start": {
        if (event.kind === "tool_call") {
          toolStreamIds.add(`${event.turnIndex}:${event.blockId}`);
          if (!event.callId) return [];
          return [setTool(event.callId, { name: event.name, status: "running" })];
        }
        const id = streamBlockId(attempt, event.turnIndex, event.blockId);
        streamKinds.set(id, event.kind);
        return [{ type: "block_set", block: { id, kind: event.kind, text: "" } }];
      }
      case "block_delta": {
        if (toolStreamIds.has(`${event.turnIndex}:${event.blockId}`)) return []; // raw args JSON — not rendered
        const id = streamBlockId(attempt, event.turnIndex, event.blockId);
        return [{ type: "block_delta", blockId: id, blockKind: streamKinds.get(id) ?? "text", delta: event.delta }];
      }
      case "block_end": {
        if (event.block.type === "tool_call") {
          return [setTool(event.block.id, { name: event.block.name, args: event.block.args, status: "running" })];
        }
        // Converge on the final block content (covers any missed delta).
        const id = streamBlockId(attempt, event.turnIndex, event.blockId);
        const text = event.block.type === "text" ? event.block.text : event.block.thinking;
        return [{ type: "block_set", block: { id, kind: event.block.type, text } }];
      }
      case "tool_execution_start":
        if (rejectedCallIds.has(event.callId)) return [];
        return [setTool(event.callId, { name: event.name, args: event.args, status: "running" })];
      case "tool_action_request":
        const displayCallId = event.kind === "custom_approval" ? (customApprovalParentCallId(event.callId) ?? event.callId) : event.callId;
        const review = approvalReviewForCallId(approvalReviews, event.callId);
        return [
          setTool(
            event.callId,
            {
              name: event.name,
              args: event.args,
              status: event.kind === "client_tool" ? "awaiting_client" : "awaiting_approval",
              approval:
                event.kind === "client_tool"
                  ? undefined
                  : {
                      message: event.message,
                      review,
                      allowAlways: review?.approvalScope !== undefined || aiToolAllowsAlways(approvalPolicies.get(event.name)),
                    },
              frontendMode: event.kind === "client_tool" ? (frontendModes.get(event.name) ?? "client") : undefined,
            },
            displayCallId,
          ),
        ];
      case "tool_execution_end":
        return [
          setTool(event.callId, {
            name: event.name,
            status: rejectedCallIds.has(event.callId) ? "rejected" : event.isError ? "failed" : "completed",
            result: event.result,
            isError: Boolean(event.isError),
            clearApproval: true,
          }),
        ];
      case "issue": {
        const callId = "callId" in event.issue ? event.issue.callId : undefined;
        if (callId && rejectedCallIds.has(callId)) return [];
        if (callId && toolBlocks.has(callId)) {
          const existing = toolBlocks.get(callId);
          if (existing && existing.status !== "completed" && existing.status !== "failed") {
            return [setTool(callId, { status: "failed", result: event.issue.message, isError: true, clearApproval: true })];
          }
        }
        return [];
      }
      case "compaction_start":
        return [compaction("running")];
      case "compaction_end":
        return [compaction("completed")];
      default:
        return [];
    }
  };

  return {
    translate,
    compaction,
    setFrontendModes,
    setPresentations,
    setCanonicalNames,
    setApprovalPolicies,
    setApprovalReviews,
    setRejectedCallIds,
  };
};

// ---------------------------------------------------------------------------
// Run-config materialization
// ---------------------------------------------------------------------------

type MaterializedChatConfig = {
  actor?: RequestActor;
  systemPrompt?: string;
  tools: AiRuntimeTool[];
  toolApprovalContext?: AiToolApprovalContext;
  modelPolicy: AiChatTurnRunConfig["modelPolicy"];
  requestedModelId?: string;
};

const materializeChatConfig = async (config: AiChatTurnRunConfig, signal: AbortSignal, turnId: string): Promise<MaterializedChatConfig> => {
  const source = config.toolSource ?? { kind: "none" };
  return {
    actor: config.actor,
    systemPrompt: config.systemPrompt,
    tools:
      source.kind === "default"
        ? [
            ...(await createConfiguredDefaultCloudAiTools()),
            ...(config.clientToolIds?.includes("local_bash") ? [createCloudAiLocalBashTool()] : []),
          ]
        : [],
    toolApprovalContext: config.toolApprovalContext,
    modelPolicy: config.modelPolicy,
    requestedModelId: config.requestedModelId,
  };
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

type AttemptOutcome = { kind: "finished"; status: "completed" | "failed" | "aborted"; error: string | null } | { kind: "suspended" };

export class AiTurnExecutor {
  constructor(private readonly config: ExecutorConfig) {}

  async run(input: { conversationId: string; turnId: string; claim: AiTurnClaim; signal: AbortSignal }): Promise<void> {
    const { conversationId, turnId, claim, signal } = input;
    const pipeline = new StreamPipeline({
      conversationId,
      turnId,
      attempt: claim.turn.attempt,
      startSeq: claim.liveSeq,
      leaseOwner: this.config.leaseOwner,
      seedBlocks: claim.liveBlocks ?? [],
    });
    const runConfig = claim.runConfig;
    if (!runConfig) {
      pipeline.seedBaseline(claim.liveBlocks ?? []);
      await pipeline.emitTurnStarted(claim.turn.modelProfileId ?? "");
      await pipeline.emitBaseline();
      await this.finalize(conversationId, turnId, pipeline, "failed", "AI turn is missing its run configuration.", null);
      return;
    }

    if (runConfig.kind === "compact") {
      pipeline.seedBaseline(claim.liveBlocks ?? []);
      await pipeline.emitTurnStarted(claim.turn.modelProfileId ?? "");
      await pipeline.emitBaseline();
      await this.runCompaction(conversationId, turnId, pipeline, runConfig, signal);
      return;
    }

    let attemptState: ChatAttemptState;
    try {
      attemptState = await loadChatAttemptState(conversationId, turnId);
    } catch (error) {
      pipeline.seedBaseline(claim.liveBlocks ?? []);
      await pipeline.emitTurnStarted(claim.turn.modelProfileId ?? "");
      await pipeline.emitBaseline();
      await this.finalize(
        conversationId,
        turnId,
        pipeline,
        "failed",
        error instanceof Error ? error.message : "AI turn state could not be loaded.",
        "chat",
      );
      return;
    }
    pipeline.seedBaseline(rebuildAttemptBaseline(attemptState));
    await pipeline.emitTurnStarted(claim.turn.modelProfileId ?? "");
    await pipeline.emitBaseline();
    await this.runChat(conversationId, turnId, claim, runConfig, pipeline, signal, false, attemptState);
  }

  private async finalize(
    conversationId: string,
    turnId: string,
    pipeline: StreamPipeline,
    status: "completed" | "failed" | "aborted",
    error: string | null,
    kind: AiTurnRunConfig["kind"] | null,
  ) {
    if (status === "failed" && error) log.error("AI turn failed", { conversationId, turnId, error });
    const finalized = await aiConversations.completeTurn({ conversationId, turnId, status, error, leaseOwner: this.config.leaseOwner });
    if (finalized === "completed") await pipeline.emitTurnFinished(status, error);
    await pipeline.flush().catch(() => undefined);
    if (finalized === "completed" && this.config.onTurnFinalized) {
      await this.config.onTurnFinalized({ conversationId, turnId, status, kind }).catch((hookError) => {
        log.warn("AI turn finalized hook failed", {
          conversationId,
          turnId,
          status,
          error: hookError instanceof Error ? hookError.message : "AI turn finalized hook failed",
        });
      });
    }
    return finalized;
  }

  private async runChat(
    conversationId: string,
    turnId: string,
    claim: AiTurnClaim,
    config: AiChatTurnRunConfig,
    pipeline: StreamPipeline,
    signal: AbortSignal,
    skipResolvedActions = false,
    attemptState?: ChatAttemptState,
  ): Promise<void> {
    const startedAt = Date.now();
    const abortController = new AbortController();
    const onSignal = () => abortController.abort();
    if (signal.aborted) abortController.abort();
    else signal.addEventListener("abort", onSignal, { once: true });

    let material: MaterializedChatConfig;
    let validated: ValidatedTurn;
    let resolvedProjectId: string | null = null;
    let chatId = config.chatId ?? "";
    try {
      const [nextMaterial, conversation] = await Promise.all([
        materializeChatConfig(config, abortController.signal, turnId),
        chatId ? Promise.resolve(null) : aiConversations.getConversation({ conversationId }),
      ]);
      material = nextMaterial;
      chatId ||= conversation?.shortId ?? "";
      if (config.project) {
        const subject = accessSubjectForActor(material.actor);
        const project = subject ? await aiProjects.getByShortId(config.project.id, subject, "read") : null;
        if (!project) {
          throw new Error("Project access is no longer available.");
        }
        resolvedProjectId = project.id;
      }
      validated = await (this.config.validateTurn ?? validateAiTurnRequest)({
        input: config.input,
        hasImageAttachments: config.files?.attached.some((file) => isAiImageMediaType(file.mediaType)),
        canInspectAttachedImages:
          material.tools.some((tool) => tool.def.name === "view_image") &&
          (await isAiVisionModelConfigured(material.modelPolicy?.allowedDataBoundaries)),
        modelPolicy: material.modelPolicy,
        requestedModelId: material.requestedModelId,
      });
    } catch (error) {
      signal.removeEventListener("abort", onSignal);
      await this.finalize(conversationId, turnId, pipeline, "failed", error instanceof Error ? error.message : "AI turn failed", "chat");
      return;
    }
    const { settings, resolved } = validated;

    const defaultToolSource = config.toolSource?.kind === "default" ? config.toolSource : null;
    const toolActor =
      defaultToolSource && resolved.profile.capabilities.includes("tools") && material.actor?.kind === "user" ? material.actor : null;
    const helpEnabled = toolActor !== null;
    const toolDiscoveryEnabled = toolActor !== null;
    const appToolsEnabled = toolActor !== null && defaultToolSource?.appTools === true;
    let capabilityAuthority: Awaited<ReturnType<typeof resolveAiCapabilityActor>> | null = null;
    try {
      capabilityAuthority = appToolsEnabled
        ? await resolveAiCapabilityActor({ conversationId, persistedActor: material.actor, store: aiConversations })
        : null;
    } catch (error) {
      signal.removeEventListener("abort", onSignal);
      await this.finalize(
        conversationId,
        turnId,
        pipeline,
        "failed",
        error instanceof Error ? error.message : "Cloud capability actor resolution failed",
        "chat",
      );
      return;
    }
    if (capabilityAuthority) material.actor = capabilityAuthority.actor;

    // Personalization applies to user-backed personal conversations.
    const user = aiActorUser(material.actor);
    let prefs: AiUserPrefs | null = null;
    if (user && config.toolSource?.kind === "default") {
      prefs = await aiUserPrefs.get(user.id);
    }
    const query = memoryQueryFromInput(config.input);
    const memoryActive = Boolean(prefs?.memoryEnabled);
    const memory = memoryActive && user ? await aiMemories.selectHot(user.id, query) : null;
    const timeZone = String((await coreSettings.get<string>("app.timezone")) || "").trim() || "UTC";
    const promptLocale = normalizeLocale(await coreSettings.get<string>("app.locale"));
    const project = config.project;
    const projectSubject = project ? accessSubjectForActor(material.actor) : null;
    // Skills are an Assistant/default-tool capability. Custom and structured
    // executions must not gain an implicit database dependency or extra tools.
    const skillSubject =
      defaultToolSource && resolved.profile.capabilities.includes("tools") ? accessSubjectForActor(material.actor) : null;
    const availableSkills = skillSubject ? (await aiSkills.list(skillSubject)).filter((skill) => skill.enabled) : [];
    const skillCatalog = selectAiSkillCatalog(availableSkills, resolved.provider.contextWindow ?? 0, query);
    const projectFiles =
      project && resolvedProjectId && projectSubject
        ? {
            list: async () =>
              (await aiProjects.listFiles(resolvedProjectId, projectSubject)).map((file) => ({
                path: file.path,
                mediaType: file.mediaType,
                size: file.size,
                updatedAt: file.updatedAt,
              })),
            read: async (path: string) => {
              const file = await aiProjects.readFileByPath(resolvedProjectId, path, projectSubject);
              return file
                ? { path: file.path, mediaType: file.mediaType, size: file.size, updatedAt: file.updatedAt, bytes: file.bytes }
                : null;
            },
          }
        : undefined;
    const skillFiles = skillSubject
      ? {
          list: () => aiSkills.listTurnFiles(turnId, skillSubject),
          read: (path: string) => aiSkills.readTurnFile(turnId, path, skillSubject),
        }
      : undefined;
    const runtimeTools = [
      ...material.tools,
      ...(memoryActive ? [createCloudAiMemoryTool(query)] : []),
      ...(skillSubject && availableSkills.length ? [createCloudAiLoadSkillTool(skillSubject)] : []),
      ...(skillSubject && skillCatalog.omitted > 0 ? [createCloudAiSearchSkillsTool(skillSubject)] : []),
      ...(config.project && resolvedProjectId && projectSubject
        ? [
            createCloudAiSearchProjectTool(resolvedProjectId, projectSubject),
            createCloudAiReadProjectKnowledgeTool(resolvedProjectId, projectSubject),
          ]
        : []),
    ];
    const toolsSupported = resolved.profile.capabilities.includes("tools");
    const activeTools = toolsSupported ? runtimeTools : [];
    const memoryToolEnabled = activeTools.some((tool) => tool.def.name === "memory");
    const projectToolEnabled = activeTools.some((tool) => tool.def.name === "search_project");

    if (config.project?.references.length) {
      await indexConversationResources({
        conversationId,
        turnId,
        resources: config.project.references.map((ref) => ({ ref })),
      });
    }

    const dynamicToolRuntimeContext = {
      turnId,
      attachedFilePaths: new Set(config.files?.attached.map((file) => file.path) ?? []),
      allowedDataBoundaries: material.modelPolicy?.allowedDataBoundaries,
      projectFiles,
      skillFiles,
      selectedModel: resolved,
    };
    const prepared = prepareAiTools({
      tools: activeTools,
      ...dynamicToolRuntimeContext,
      actor: material.actor,
      conversationId,
    });
    const rememberableCapabilityApprovals = new Map<string, string>();
    const capabilityActionReviews = new Map<string, CapabilityActionReview>();
    pipeline.setFrontendModes(prepared.frontendModes);
    pipeline.setCanonicalNames(prepared.canonicalNames);
    pipeline.setApprovalPolicies(prepared.approvalPolicies);
    const toolPresentations = new Map<string, AiToolPresentation>();
    const rejectedToolCallIds = new Set<string>();
    pipeline.setPresentations(toolPresentations);
    pipeline.setApprovalReviews(capabilityActionReviews);
    let turnInput = config.input;
    try {
      if (resolved.profile.capabilities.includes("vision") && config.files?.attached.some((file) => isAiImageMediaType(file.mediaType))) {
        const parts = typeof turnInput === "string" ? [{ type: "text" as const, text: turnInput }] : [...turnInput];
        for (const file of config.files.attached) {
          if (!isAiImageMediaType(file.mediaType)) continue;
          const stored = await aiFileStore.readTurnFile({ turnId, path: file.path });
          if (!stored) throw new Error(`Attached conversation image is no longer available: ${file.path}`);
          parts.push({ type: "file", mediaType: stored.mediaType, data: Buffer.from(stored.bytes).toString("base64") });
        }
        turnInput = parts;
      }
    } catch (error) {
      signal.removeEventListener("abort", onSignal);
      await this.finalize(
        conversationId,
        turnId,
        pipeline,
        "failed",
        error instanceof Error ? error.message : "Image preparation failed",
        "chat",
      );
      return;
    }
    const store = aiConversations.createSessionStore({
      conversationId,
      modelProfileId: resolved.profile.id,
      turnId,
      leaseOwner: this.config.leaseOwner,
      turnInput,
      toolPresentations,
      rejectedToolCallIds,
    });

    const { loopMessages, pendingRecords, resolvedRecords, turnSteers } =
      attemptState ?? (await loadChatAttemptState(conversationId, turnId));
    for (const action of resolvedRecords) {
      if (action.resolvedEvent?.type !== "approval_response" || action.resolvedEvent.approved) continue;
      rejectedToolCallIds.add(
        action.kind === "custom_approval" ? (customApprovalParentCallId(action.callId) ?? action.callId) : action.callId,
      );
    }
    pipeline.setRejectedCallIds(rejectedToolCallIds);
    const assistantMessages = loopMessages.filter((message) => message.message.role !== "user");
    const isFresh = assistantMessages.length === 0 && resolvedRecords.length === 0 && !skipResolvedActions;

    // Rebuild the whole active-turn view so a re-run/continuation reconstructs it.
    if (!attemptState) {
      pipeline.seedBaseline(rebuildAttemptBaseline({ loopMessages, pendingRecords, resolvedRecords, turnSteers }));
      await pipeline.emitBaseline();
    }

    const appliedSteers: AiTurnSteer[] = [];

    const tools = toolActor
      ? createAiToolResolver({
          conversationId,
          actor: capabilityAuthority?.actor ?? toolActor,
          staticTools: activeTools,
          runtimeContext: dynamicToolRuntimeContext,
          store: aiConversations,
          ...(capabilityAuthority ? { listRegistry: listCapabilities } : {}),
          onCapabilityRegistryError: (error) =>
            log.warn("AI Capability registry unavailable; continuing without app capabilities", {
              error: error instanceof Error ? error.message : String(error),
            }),
          listHelpRegistry: loadCurrentHelp,
          onHelpRegistryError: (error) =>
            log.warn("AI Help registry unavailable; continuing without Help documents", {
              error: error instanceof Error ? error.message : String(error),
            }),
          maxLoadedTools: resolved.profile.maxLoadedTools,
          ...(capabilityAuthority
            ? {
                review: (entry, args, context) =>
                  reviewAiCapability({
                    conversationId,
                    authority: capabilityAuthority!,
                    entry,
                    args,
                    context,
                  }),
              }
            : {}),
          onReview: (callId, review) => {
            capabilityActionReviews.set(callId, review);
            if (review.approvalScope) rememberableCapabilityApprovals.set(callId, review.approvalScope);
          },
          ...(capabilityAuthority
            ? {
                execute: async (entry, args, context) => {
                  try {
                    const result = await executeAiCapability({
                      conversationId,
                      turnId,
                      authority: capabilityAuthority!,
                      entry,
                      args,
                      context,
                    });
                    const resources = collectConversationResourceObservations(args, result);
                    if (resources.length) {
                      await Promise.all([
                        indexConversationResources({ conversationId, turnId, callId: context.callId, resources }),
                        recordMemoryWorkflowEvidence({
                          userId: capabilityAuthority.actor.user.id,
                          conversationId,
                          turnId,
                          capabilityId: entry.name,
                          resources,
                        }),
                      ]);
                    }
                    return result;
                  } catch (error) {
                    const resources = collectConversationResourceObservations(args);
                    if (resources.length) {
                      await indexConversationResources({ conversationId, turnId, callId: context.callId, resources });
                    }
                    throw error;
                  }
                },
              }
            : {}),
          onPrepared: ({ prepared: snapshot, presentations, rememberableApprovals }) => {
            prepared.canonicalNames.clear();
            prepared.approvalPolicies.clear();
            prepared.frontendModes.clear();
            rememberableCapabilityApprovals.clear();
            toolPresentations.clear();
            for (const [name, canonicalName] of snapshot.canonicalNames) prepared.canonicalNames.set(name, canonicalName);
            for (const [name, policy] of snapshot.approvalPolicies) prepared.approvalPolicies.set(name, policy);
            for (const [name, mode] of snapshot.frontendModes) prepared.frontendModes.set(name, mode);
            for (const [name, scope] of rememberableApprovals) rememberableCapabilityApprovals.set(name, scope);
            for (const [name, presentation] of presentations) toolPresentations.set(name, presentation);
            pipeline.setFrontendModes(prepared.frontendModes);
            pipeline.setCanonicalNames(prepared.canonicalNames);
            pipeline.setApprovalPolicies(prepared.approvalPolicies);
            pipeline.setPresentations(toolPresentations);
          },
        })
      : prepared.tools;

    const systemPrompt = composeAiSystemPrompt({
      globalInstructions: settings.globalInstructions,
      turnInstructions: material.systemPrompt,
      chatId,
      project: config.project,
      files: config.files,
      projectToolEnabled,
      skills: activeTools.some((tool) => tool.def.name === "load_skill") ? skillCatalog.skills : undefined,
      omittedSkillCount: activeTools.some((tool) => tool.def.name === "search_skills") ? skillCatalog.omitted : 0,
      user,
      memoryEnabled: memoryActive,
      memoryToolEnabled,
      helpEnabled,
      toolDiscoveryEnabled,
      appToolsEnabled,
      toolHints: aiToolPromptHints(activeTools),
      memory: memory?.text,
      timeZone,
      locale: promptLocale,
    });
    const priorToolRounds = toolRoundState(loopMessages);
    const toolRoundPolicy = applyToolRoundPolicy({
      provider: resolved.provider,
      tools,
      maxToolRounds: resolved.profile.maxToolRounds,
      issuedToolRounds: priorToolRounds.issued,
      completedToolRounds: priorToolRounds.completed,
    });
    const loop = nessi({
      agentId: "cloud",
      loopId: turnId,
      ...(isFresh ? { input: turnInput } : {}),
      provider: toolRoundPolicy.provider,
      systemPrompt,
      store,
      steering: async ({ signal: steeringSignal }) => {
        if (steeringSignal.aborted) return undefined;
        const steers = await aiConversations.takePendingTurnSteers({
          conversationId,
          turnId,
          leaseOwner: this.config.leaseOwner,
        });
        appliedSteers.push(...steers);
        return steers.length > 0 ? steers.map((steer) => steer.text) : undefined;
      },
      tools: toolRoundPolicy.tools,
      ...(toolRoundPolicy.maxTurns === undefined ? {} : { maxTurns: toolRoundPolicy.maxTurns }),
      temperature: resolved.profile.temperature,
      maxOutputTokens: resolved.profile.maxOutputTokens,
      coalesce: { ms: AI_COALESCE_MS, maxChars: AI_COALESCE_MAX_CHARS },
      compact: createCloudCompactFn({
        conversationId,
        modelProfileId: resolved.profile.id,
        additionalInstructions: settings.compactionInstructions,
        maxOutputTokens: resolved.profile.maxOutputTokens,
        signal: abortController.signal,
      }),
      maxToolResultChars: resolveAiToolResultMaxChars({
        contextWindow: resolved.provider.contextWindow,
        configuredMaxChars: settings.maxToolResultChars,
      }),
      signal: abortController.signal,
    });

    // Seed the resumed loop with resolved actions before iterating.
    for (const record of skipResolvedActions ? [] : resolvedRecords) {
      if (record.resolvedEvent) loop.push(record.resolvedEvent);
    }

    const outcome = await this.driveChatLoop({
      loop,
      pipeline,
      conversationId,
      turnId,
      abortController,
      prepared,
      approvalContext: material.toolApprovalContext,
      rememberableCapabilityApprovals,
      capabilityActionReviews,
      appliedSteers,
      noteToolRound: toolRoundPolicy.noteToolRound,
    });
    signal.removeEventListener("abort", onSignal);

    if (outcome.kind === "suspended") {
      log.info("AI turn suspended", { conversationId, turnId, attempt: claim.turn.attempt, durationMs: Date.now() - startedAt });
      await this.config.enqueueContinuation({ conversationId, turnId }).catch(() => undefined);
      await pipeline.flush().catch(() => undefined);
      return;
    }

    const finalized = await this.finalize(conversationId, turnId, pipeline, outcome.status, outcome.error, "chat");
    if (finalized === "pending_steering" && outcome.status === "completed" && !signal.aborted) {
      await this.runChat(conversationId, turnId, claim, config, pipeline, signal, true);
      return;
    }
    log.info("AI turn finished", {
      conversationId,
      turnId,
      attempt: claim.turn.attempt,
      status: outcome.status,
      durationMs: Date.now() - startedAt,
      firstBlockMs: pipeline.firstBlockMs,
      wireSeq: pipeline.seq,
    });
  }

  private async driveChatLoop(input: {
    loop: NessiLoop;
    pipeline: StreamPipeline;
    conversationId: string;
    turnId: string;
    abortController: AbortController;
    prepared: PreparedAiTools;
    approvalContext?: AiToolApprovalContext;
    rememberableCapabilityApprovals: ReadonlyMap<string, string>;
    capabilityActionReviews: ReadonlyMap<string, CapabilityActionReview>;
    appliedSteers: AiTurnSteer[];
    noteToolRound: () => void;
  }): Promise<AttemptOutcome> {
    const {
      loop,
      pipeline,
      conversationId,
      turnId,
      abortController,
      prepared,
      approvalContext,
      rememberableCapabilityApprovals,
      capabilityActionReviews,
      appliedSteers,
      noteToolRound,
    } = input;
    const stopHeartbeat = this.startHeartbeat(conversationId, turnId, abortController);
    let lastIssueMessage: string | null = null;

    try {
      for await (const event of loop) {
        if (event.type === "tool_action_request") {
          const suspended = await this.handleActionRequest({
            event,
            loop,
            pipeline,
            conversationId,
            turnId,
            prepared,
            approvalContext,
            rememberableCapabilityApprovals,
            capabilityActionReviews,
          });
          if (suspended) {
            abortController.abort();
            loop.abort();
            return { kind: "suspended" };
          }
          continue;
        }

        if (event.type === "steer_applied") {
          const steer = appliedSteers.shift();
          if (steer) await pipeline.applySteer(steer);
        } else {
          await pipeline.apply(event);
        }

        if (event.type === "tool_execution_start") {
          const toolName = prepared.canonicalNames.get(event.name) ?? event.name;
          await aiToolAudit
            .noteToolCall({
              conversationId,
              turnId,
              callId: event.callId,
              toolName,
              location: prepared.frontendModes.get(event.name) ?? "server",
              args: event.args,
            })
            .catch(() => undefined);
        } else if (event.type === "tool_execution_end") {
          await aiToolAudit
            .noteToolCompleted({ turnId, callId: event.callId, result: event.result, isError: event.isError })
            .catch(() => undefined);
          await indexConversationToolSource({
            conversationId,
            turnId,
            callId: event.callId,
            name: event.name,
            result: event.result,
            isError: event.isError === true,
          });
        } else if (event.type === "turn_end" && event.message.content.some((block) => block.type === "tool_call")) {
          noteToolRound();
        } else if (event.type === "issue") {
          lastIssueMessage = event.issue.message;
          log.warn("AI turn issue", { conversationId, turnId, kind: event.issue.kind, message: event.issue.message });
        } else if (event.type === "loop_end") {
          const aggregate = event.aggregate;
          if (aggregate.assistantMessageCount > 0) {
            await aiConversations
              .setLatestAssistantLoopAggregate({ conversationId, loopId: turnId, aggregate, doneReason: event.reason })
              .catch(() => undefined);
          }
          if (event.reason === "aborted") return { kind: "finished", status: "aborted", error: null };
          if (event.reason === "stop") return { kind: "finished", status: "completed", error: null };
          if (event.reason === "max_turns") {
            return { kind: "finished", status: "failed", error: "The model did not produce a final answer within its tool-round limit." };
          }
          return { kind: "finished", status: "failed", error: lastIssueMessage ?? `AI turn ended: ${event.reason}` };
        }
      }
      return { kind: "finished", status: abortController.signal.aborted ? "aborted" : "completed", error: null };
    } catch (error) {
      if (abortController.signal.aborted) return { kind: "finished", status: "aborted", error: null };
      const message = error instanceof Error ? error.message : "AI turn failed";
      await pipeline.emitError(message).catch(() => undefined);
      return { kind: "finished", status: "failed", error: message };
    } finally {
      stopHeartbeat();
      await pipeline.flush().catch(() => undefined);
    }
  }

  /** Returns true when the turn was suspended for the action; false when resolved inline. */
  private async handleActionRequest(input: {
    event: Extract<OutboundEvent, { type: "tool_action_request" }>;
    loop: NessiLoop;
    pipeline: StreamPipeline;
    conversationId: string;
    turnId: string;
    prepared: PreparedAiTools;
    approvalContext?: AiToolApprovalContext;
    rememberableCapabilityApprovals: ReadonlyMap<string, string>;
    capabilityActionReviews: ReadonlyMap<string, CapabilityActionReview>;
  }): Promise<boolean> {
    const {
      event,
      loop,
      pipeline,
      conversationId,
      turnId,
      prepared,
      approvalContext,
      rememberableCapabilityApprovals,
      capabilityActionReviews,
    } = input;
    const approvalPolicy = prepared.approvalPolicies.get(event.name);
    const toolName = prepared.canonicalNames.get(event.name) ?? event.name;
    const frontendMode: AiFrontendToolMode | undefined =
      event.kind === "client_tool" ? (prepared.frontendModes.get(event.name) ?? "client") : undefined;
    const capabilityApprovalScope =
      event.kind === "custom_approval"
        ? rememberableCapabilityApprovals.get(customApprovalParentCallId(event.callId) ?? event.callId)
        : undefined;
    const approvalScope = capabilityApprovalScope ?? aiToolApprovalScope(toolName, approvalPolicy);
    const allowAlways = capabilityApprovalScope !== undefined || aiToolAllowsAlways(approvalPolicy);

    // Display-only client_view tools (e.g. cards) never need user input — resolve
    // inline and keep streaming instead of taking a full suspend/continuation trip.
    if (frontendMode === "client_view") {
      await pipeline.apply(event);
      loop.push({ type: "tool_result", callId: event.callId, result: { displayed: true } });
      // Mark the block completed immediately: nessi emits no tool_execution_end
      // for client tools, and a block stuck in awaiting_client would look like
      // an open action request if the turn suspends for another tool later.
      await pipeline.apply({
        type: "tool_execution_end",
        callId: event.callId,
        name: event.name,
        result: { displayed: true },
        isError: false,
      } as OutboundEvent);
      await aiToolAudit
        .noteToolCompleted({ turnId, callId: event.callId, result: { displayed: true }, isError: false })
        .catch(() => undefined);
      return false;
    }

    // Remembered approvals resolve inline too.
    if (event.kind !== "client_tool" && allowAlways && approvalContext) {
      const remembered = await hasRememberedAiToolApproval(approvalContext, { toolName, approvalScope }).catch(() => false);
      if (remembered) {
        await aiToolAudit
          .noteApprovalResolved({ turnId, callId: event.callId, approvalState: "approved_by_preference" })
          .catch(() => undefined);
        loop.push({ type: "approval_response", callId: event.callId, approved: true });
        return false;
      }
    }

    await aiConversations.savePendingTurnAction({
      turnId,
      conversationId,
      callId: event.callId,
      kind: event.kind,
      status: "pending",
      name: toolName,
      args: event.args,
      message: event.message,
      review: event.kind === "custom_approval" ? approvalReviewForCallId(capabilityActionReviews, event.callId) : undefined,
      approvalScope,
      allowAlways,
      frontendMode,
      resolvedEvent: null,
    });

    if (event.kind === "client_tool") {
      await aiToolAudit
        .noteToolCall({
          conversationId,
          turnId,
          callId: event.callId,
          toolName,
          location: frontendMode ?? "client",
          args: event.args,
          status: "waiting_for_frontend",
        })
        .catch(() => undefined);
    } else {
      await aiToolAudit
        .noteApprovalRequested({ conversationId, turnId, callId: event.callId, toolName, location: "server", args: event.args })
        .catch(() => undefined);
    }

    await pipeline.apply(event);
    const suspended = await aiConversations.suspendTurn({
      conversationId,
      turnId,
      leaseOwner: this.config.leaseOwner,
      blocks: pipeline.blocks,
      seq: pipeline.seq,
      waitingBudgetMs: AI_ACTION_BUDGET_MS,
    });
    await pipeline.flush().catch(() => undefined);
    return suspended;
  }

  private startHeartbeat(conversationId: string, turnId: string, abortController: AbortController): () => void {
    let stopped = false;
    let failures = 0;
    const tick = async () => {
      if (stopped) return;
      let ok = false;
      try {
        ok = await aiConversations.heartbeatTurn({
          conversationId,
          turnId,
          leaseOwner: this.config.leaseOwner,
          leaseMs: AI_TURN_LEASE_MS,
        });
        failures = 0;
      } catch {
        failures += 1;
        if (failures < 3) return;
      }
      if (!ok && !stopped) abortController.abort();
    };
    const timer = setInterval(() => void tick(), this.config.heartbeatMs);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    void tick();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  private async runCompaction(
    conversationId: string,
    turnId: string,
    pipeline: StreamPipeline,
    config: Extract<AiTurnRunConfig, { kind: "compact" }>,
    signal: AbortSignal,
  ): Promise<void> {
    const abortController = new AbortController();
    const onSignal = () => abortController.abort();
    if (signal.aborted) abortController.abort();
    else signal.addEventListener("abort", onSignal, { once: true });

    let validated: ValidatedTurn;
    try {
      validated = await (this.config.validateTurn ?? validateAiTurnRequest)({
        input: "",
        modelPolicy: config.modelPolicy,
        requestedModelId: config.requestedModelId,
      });
    } catch (error) {
      signal.removeEventListener("abort", onSignal);
      await this.finalize(
        conversationId,
        turnId,
        pipeline,
        "failed",
        error instanceof Error ? error.message : "AI compaction failed",
        "compact",
      );
      return;
    }
    const { settings, resolved } = validated;

    const store = aiConversations.createSessionStore({
      conversationId,
      modelProfileId: resolved.profile.id,
      turnId,
      leaseOwner: this.config.leaseOwner,
    });
    const loop = compact({
      agentId: "cloud",
      loopId: turnId,
      store,
      provider: resolved.provider,
      force: true,
      signal: abortController.signal,
      compact: createCloudCompactFn({
        conversationId,
        modelProfileId: resolved.profile.id,
        additionalInstructions: settings.compactionInstructions,
        maxOutputTokens: resolved.profile.maxOutputTokens,
        signal: abortController.signal,
        // Manual /compact means "make the context small": summarize everything
        // except the latest loop, so the marker lands right above the newest
        // messages instead of far up the chat.
        keepRecentLoops: 1,
      }),
    });

    const stopHeartbeat = this.startHeartbeat(conversationId, turnId, abortController);
    let status: "completed" | "failed" | "aborted" = "failed";
    let error: string | null = null;
    try {
      for await (const event of loop as AsyncIterable<CompactEvent>) {
        if (event.type === "compaction_start") await pipeline.applyCompaction("running");
        else if (event.type === "compaction_end") await pipeline.applyCompaction("completed");
        else if (event.type === "issue") error = event.issue.message;
        else if (event.type === "loop_end") {
          status = event.reason === "stop" ? "completed" : event.reason === "aborted" ? "aborted" : "failed";
          await pipeline.applyCompaction(status === "failed" ? "failed" : "completed", event.result);
        }
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        status = "aborted";
      } else {
        status = "failed";
        error = err instanceof Error ? err.message : "AI compaction failed";
        await pipeline.emitError(error).catch(() => undefined);
      }
    } finally {
      stopHeartbeat();
      signal.removeEventListener("abort", onSignal);
    }

    await this.finalize(conversationId, turnId, pipeline, status, error, "compact");
  }
}

// ---------------------------------------------------------------------------
// Stream pipeline — seq allocation, ordered publish + snapshot throttle
// ---------------------------------------------------------------------------

class StreamPipeline {
  blocks: AiTurnBlock[];
  seq: number;
  /** Wall-clock ms from construction to the first streamed block op (provider TTFB proxy). */
  firstBlockMs: number | null = null;
  private readonly createdAt = Date.now();
  private readonly conversationId: string;
  private readonly turnId: string;
  private readonly attempt: number;
  private readonly leaseOwner: string;
  private readonly mapper: ReturnType<typeof createEventMapper>;
  private lastSnapshotAt = 0;
  private snapshotDirty = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(input: {
    conversationId: string;
    turnId: string;
    attempt: number;
    startSeq: number;
    leaseOwner: string;
    seedBlocks: AiTurnBlock[];
  }) {
    this.conversationId = input.conversationId;
    this.turnId = input.turnId;
    this.attempt = input.attempt;
    this.leaseOwner = input.leaseOwner;
    this.seq = input.startSeq;
    this.blocks = [];
    this.mapper = createEventMapper(input.attempt, input.seedBlocks);
  }

  private ordered(run: () => Promise<void>): Promise<void> {
    this.chain = this.chain.catch(() => undefined).then(run);
    return this.chain;
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  private envelope<T extends { type: string }>(event: T): T & { v: 1; conversationId: string; turnId: string; attempt: number } {
    return { ...event, v: 1, conversationId: this.conversationId, turnId: this.turnId, attempt: this.attempt };
  }

  seedBaseline(blocks: AiTurnBlock[]): void {
    this.blocks = blocks;
  }

  setFrontendModes(modes: Map<string, AiFrontendToolMode>): void {
    this.mapper.setFrontendModes(modes);
  }

  setPresentations(presentations: Map<string, AiToolPresentation>): void {
    this.mapper.setPresentations(presentations);
  }

  setCanonicalNames(names: Map<string, string>): void {
    this.mapper.setCanonicalNames(names);
  }

  setApprovalReviews(reviews: Map<string, CapabilityActionReview>): void {
    this.mapper.setApprovalReviews(reviews);
  }

  setApprovalPolicies(policies: PreparedAiTools["approvalPolicies"]): void {
    this.mapper.setApprovalPolicies(policies);
  }

  setRejectedCallIds(callIds: Set<string>): void {
    this.mapper.setRejectedCallIds(callIds);
  }

  async emitBaseline(): Promise<void> {
    for (const block of this.blocks) {
      const seq = this.nextSeq();
      await this.publish(this.envelope({ type: "block_set" as const, seq, block }) as AiWireEvent);
    }
    this.snapshotDirty = this.blocks.length > 0;
  }

  async emitTurnStarted(modelProfileId: string): Promise<void> {
    const seq = this.nextSeq();
    await this.publish(
      this.envelope({ type: "turn_started" as const, seq, modelProfileId, providerModel: "", blocks: this.blocks }) as AiWireEvent,
    );
  }

  async apply(event: OutboundEvent): Promise<void> {
    const ops = this.mapper.translate(event);
    if (ops.length > 0 && this.firstBlockMs === null) this.firstBlockMs = Date.now() - this.createdAt;
    for (const op of ops) await this.emitOp(op);
    await this.maybeSnapshot();
  }

  async applySteer(steer: AiTurnSteer): Promise<void> {
    await this.emitOp({
      type: "block_set",
      block: {
        id: steerMessageBlockId(steer.id),
        kind: "steer_message",
        steerId: steer.id,
        text: steer.text,
        status: "consumed",
      },
    });
    await this.emitOp({
      type: "block_set",
      block: { id: steerAppliedBlockId(steer.id), kind: "steer_applied", steerId: steer.id },
    });
    await this.maybeSnapshot();
  }

  async applyCompaction(
    status: "running" | "completed" | "failed",
    result?: Extract<AiTurnBlock, { kind: "compaction" }>["result"],
  ): Promise<void> {
    await this.emitOp(this.mapper.compaction(status, result));
    await this.maybeSnapshot();
  }

  private async emitOp(
    op: { type: "block_set"; block: AiTurnBlock } | { type: "block_delta"; blockId: string; blockKind: "text" | "thinking"; delta: string },
  ): Promise<void> {
    const seq = this.nextSeq();
    const event = this.envelope({ ...op, seq }) as AiWireEvent;
    this.blocks = applyWireEventToBlocks(this.blocks, event);
    this.snapshotDirty = true;
    await this.publish(event);
  }

  private async maybeSnapshot(): Promise<void> {
    if (!this.snapshotDirty) return;
    if (Date.now() - this.lastSnapshotAt < AI_SNAPSHOT_INTERVAL_MS) return;
    await this.persistSnapshot();
  }

  async persistSnapshot(): Promise<void> {
    this.lastSnapshotAt = Date.now();
    this.snapshotDirty = false;
    await aiConversations
      .saveTurnLiveState({
        conversationId: this.conversationId,
        turnId: this.turnId,
        leaseOwner: this.leaseOwner,
        blocks: this.blocks,
        seq: this.seq,
      })
      .catch(() => undefined);
  }

  async emitError(message: string): Promise<void> {
    const seq = this.nextSeq();
    const block: AiTurnBlock = { id: `error-${this.attempt}-${seq}`, kind: "text", text: `⚠️ ${message}` };
    const event = this.envelope({ type: "block_set" as const, seq, block }) as AiWireEvent;
    this.blocks = applyWireEventToBlocks(this.blocks, event);
    await this.publish(event);
  }

  async emitTurnFinished(status: "completed" | "failed" | "aborted", error: string | null): Promise<void> {
    const seq = this.nextSeq();
    await this.publish(this.envelope({ type: "turn_finished" as const, seq, status, error }) as AiWireEvent);
  }

  private publish(event: AiWireEvent): Promise<void> {
    return this.ordered(() => publishAiWireEvent(event).catch(() => undefined));
  }

  async flush(): Promise<void> {
    await this.chain;
  }
}

export const __aiExecutorTest = {
  applyToolRoundPolicy,
  createEventMapper,
  rebuildAttemptBaseline,
  rebuildBlocksFromMessages,
  toolRoundState,
};
