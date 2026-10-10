import type { AssistantMessage, CompactEvent, LoopAggregate, NessiLoop, OutboundEvent } from "@k2b/nessi";
import { compact, nessi } from "@k2b/nessi";
import { listCapabilities } from "../_internal/registry";
import type { CapabilityActionReview } from "../contracts/capabilities";
import type { AccessSubject, RequestActor } from "../server";
import { createHelpReader } from "../services/help";
import { logger } from "../services/logging";
import { getMandate } from "../services/mandates";
import type { MandatePolicyV1 } from "../services/mandates/policy";
import { coreSettings } from "../services/settings/api";
import { normalizeLocale } from "../shared/locale";
import {
  AI_WEBSITE_APPROVAL_TOOL,
  type AiToolApprovalContext,
  aiToolAllowsAlways,
  aiToolApprovalScope,
  aiTurnAllowsRememberedApprovals,
  hasRememberedAiToolApproval,
} from "./approvals";
import { aiChatAccessSubject, isAssistantChatTurn, resolveAssistantAudioModel } from "./assistant-models";
import { CODE_RUNTIME_TOOL_NAMES } from "./browser-code-contracts";
import { type AiCapabilityCatalogEntry, createAiToolResolver, createRunToolStore } from "./capabilities";
import { AiCapabilityExecutionError, executeAiCapability, resolveAiCapabilityActor, reviewAiCapability } from "./capability-execution";
import { aiChatMessages } from "./chat/messages";
import { aiTurnErrorText } from "./chat/turn-error";
import { AiChatTaskAuthorityError, aiChatTasks } from "./chat-tasks";
import { createCloudCompactFn } from "./compaction";
import { createCloudAiCodeTools, createCloudAiLocalBashTool, createConfiguredDefaultCloudAiTools } from "./default-tools";
import { aiFileStore } from "./files-store";
import { aiMemories } from "./memories";
import { createCloudAiMemoryTool } from "./memory-tool";
import { recordAiMemoryWorkflowEvidence } from "./memory-workflow-evidence";
import { aiModelAccess } from "./model-access";
import { answerOpenToolCalls } from "./open-tool-calls";
import { type AiUserPrefs, aiActorUser, aiUserPrefs } from "./prefs";
import { createCloudAiReadProjectKnowledgeTool, createCloudAiSearchProjectTool } from "./project-tool";
import { aiProjects } from "./projects";
import {
  AI_TURN_LEASE_MS,
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
import { retryTransientProviderErrors } from "./provider-retry";
import { assistantQuotaProvider, inferenceProvider } from "./quota-provider";
import { collectConversationResourceObservations } from "./resource-refs";
import { AiRunTimeout } from "./run-timeout";
import { isAiVisionModelConfigured, type resolveAiModel } from "./settings";
import { selectAiSkillCatalog } from "./skill-catalog";
import { createCloudAiLoadSkillTool, createCloudAiSearchSkillsTool, loadSelectedAiSkills } from "./skill-tool";
import { aiSkills } from "./skills";
import { aiConversations } from "./store";
import { AI_LIVE_SNAPSHOT_INTERVAL_MS, publishAiWireEvent } from "./stream";
import { composeAiSystemPrompt } from "./system-prompt";
import { aiToolAudit } from "./tool-audit";
import { acceptCanonicalToolNames } from "./tool-call-names";
import { resolveAiToolResultMaxChars } from "./tool-result-budget";
import { aiToolPromptHints, type PreparedAiTools, prepareAiTools } from "./tools";
import { AiTranscriptionError } from "./transcription";
import {
  AiTurnFailure,
  type AiTurnFailureInfo,
  type AiTurnFailureReason,
  aiTurnFailureFromThrown,
  aiTurnReasonFromThrown,
  rememberProviderErrors,
} from "./turn-failure";
import { type AiTurnGuidance, loadAiTurnGuidance } from "./turn-guidance";
import { type AiTurnPolicyToolCall, applyAiTurnPolicy } from "./turn-policy";
import { createTurnTimingRecorder, withDurableTurnTiming } from "./turn-timing";
import type {
  AiApprovalTarget,
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

const AI_COALESCE_MS = 25;
const AI_COALESCE_MAX_CHARS = 512;
const AI_ACTION_BUDGET_MS = 24 * 60 * 60_000;

// Failed generation can contain calls that nessi deliberately never executes or resumes.
const isToolRound = (message: AssistantMessage): boolean =>
  message.stopReason !== "error" &&
  message.stopReason !== "interrupted" &&
  message.stopReason !== "aborted" &&
  message.content.some((block) => block.type === "tool_call");

const toolRoundState = (messages: AiStoredMessage[]): { issued: number; completed: number } => {
  const completedCallIds = new Set(messages.flatMap(({ message }) => (message.role === "tool_result" ? [message.callId] : [])));
  const rounds = messages.flatMap(({ message }) => {
    if (message.role !== "assistant" || !isToolRound(message)) return [];
    const callIds = message.content.flatMap((block) => (block.type === "tool_call" ? [block.id] : []));
    return callIds.length > 0 ? [callIds] : [];
  });
  return {
    issued: rounds.length,
    completed: rounds.filter((callIds) => callIds.every((callId) => completedCallIds.has(callId))).length,
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

/**
 * Indexes what a finished tool call read or delivered; never throws. A browser tool ends here too, once the turn
 * continues with the result the browser reported.
 */
const indexConversationToolSource = async (input: {
  conversationId: string;
  turnId: string;
  callId: string;
  name: string;
  args: unknown;
  result: unknown;
  isError: boolean;
}): Promise<void> => {
  if (input.isError) return;
  try {
    if (input.name.startsWith("code_")) {
      const resources = collectConversationResourceObservations(input.result);
      if (resources.length)
        await indexConversationResources({
          conversationId: input.conversationId,
          turnId: input.turnId,
          callId: input.callId,
          resources,
        });
    }
    let source: Parameters<typeof aiConversations.indexConversationSource>[0]["source"] | null = null;
    const args = typeof input.args === "object" && input.args !== null ? (input.args as Record<string, unknown>) : {};
    const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
    const result = typeof input.result === "object" && input.result !== null ? (input.result as Record<string, unknown>) : {};
    if (input.name === "web_search") {
      const query = text(args.query);
      // One entry per query: each search is something the user may want to see that the assistant looked up.
      const key = query ? `web_search:${query.replace(/\s+/gu, " ").toLocaleLowerCase()}` : "web_search";
      source = { kind: "activity", key, title: query || "Web search", preview: "Searched the web", icon: "ti ti-world" };
    } else if (input.name === "present" && text(result.path)) {
      const path = text(result.path);
      source = {
        kind: "result",
        key: path,
        title: text(args.title) || path.slice(path.lastIndexOf("/") + 1),
        preview: text(args.description) || undefined,
        icon: "ti ti-file",
      };
    } else if (
      input.name === "code_open" &&
      text(args.id) &&
      typeof input.result === "object" &&
      input.result !== null &&
      !("error" in input.result)
    ) {
      // The browser reports a failure as a result with an error, which reaches this point without isError.
      source = {
        kind: "result",
        key: `assistant.artifact:${text(args.id)}`,
        title: "Studio app",
        icon: "ti ti-app-window",
        ref: { type: "assistant.artifact", id: text(args.id) },
      };
    } else if (input.name === "code_present" && text(result.presentationId)) {
      source = {
        kind: "result",
        key: `code_present:${input.callId}`,
        title: text(args.title) || text(result.title) || "Visualization",
        icon: "ti ti-chart-dots",
      };
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
  /** Waits before retrying a transient provider failure without Retry-After; tests shorten them. */
  providerRetryDelaysMs?: readonly number[];
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
          action.kind === "client_tool"
            ? undefined
            : {
                message: action.message,
                review: action.review,
                allowAlways: action.allowAlways,
                allowChat: action.allowChat ?? action.allowAlways,
                ...(action.rememberToolName === AI_WEBSITE_APPROVAL_TOOL ? { website: action.approvalScope } : {}),
              },
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
const createEventMapper = (attempt: number, seedBlocks: AiTurnBlock[], allowRememberedApprovals = true) => {
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
  let approvalTargets: ReadonlyMap<string, AiApprovalTarget> = new Map();
  const setApprovalTargets = (items: ReadonlyMap<string, AiApprovalTarget>) => {
    approvalTargets = items;
  };
  let rejectedCallIds = new Set<string>();
  const setRejectedCallIds = (items: Set<string>) => {
    rejectedCallIds = items;
  };
  let approvedCallIds = new Set<string>();
  const setApprovedCallIds = (items: Set<string>) => {
    approvedCallIds = items;
  };
  /** nessi stream block ids (turn-scoped) that belong to tool_call blocks — their deltas are raw args JSON. */
  const toolStreamIds = new Set<string>();
  /** kind per open Cloud stream block id, for delta create-if-missing. */
  const streamKinds = new Map<string, "text" | "thinking">();

  const setTool = (callId: string, patch: ToolBlockPatch, displayCallId = callId): BlockOp => {
    const existing = toolBlocks.get(callId);
    const rawName = patch.name ?? existing?.name ?? "tool";
    const name = canonicalNames.get(rawName) ?? rawName;
    const approval = patch.clearApproval ? undefined : "approval" in patch ? patch.approval : existing?.approval;
    const block: Extract<AiTurnBlock, { kind: "tool" }> = {
      id: toolBlockId(displayCallId),
      kind: "tool",
      callId,
      name,
      args: "args" in patch ? patch.args : existing?.args,
      status: patch.status ?? existing?.status ?? "running",
      result: "result" in patch ? patch.result : existing?.result,
      isError: "isError" in patch ? patch.isError : existing?.isError,
      approval: approval && !allowRememberedApprovals ? { ...approval, allowAlways: false, allowChat: false } : approval,
      frontendMode: patch.frontendMode ?? existing?.frontendMode,
      presentation: patch.presentation ?? existing?.presentation ?? presentations.get(rawName) ?? presentations.get(name),
      ...(approvedCallIds.has(callId) || approvedCallIds.has(displayCallId) || existing?.approved ? { approved: true } : {}),
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
        const target = event.kind === "custom_approval" ? approvalTargets.get(event.callId) : undefined;
        const allowAlways = target
          ? target.always
          : review?.approvalScope !== undefined || aiToolAllowsAlways(approvalPolicies.get(event.name));
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
                      allowAlways,
                      allowChat: target !== undefined || allowAlways,
                      ...(target?.toolName === AI_WEBSITE_APPROVAL_TOOL ? { website: target.approvalScope } : {}),
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
    setApprovalTargets,
    setRejectedCallIds,
    setApprovedCallIds,
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
            ...(await createConfiguredDefaultCloudAiTools({
              accessSubject: aiChatAccessSubject(config.actor),
              allowedDataBoundaries: config.modelPolicy?.allowedDataBoundaries,
            })),
            // Cloud runs the code tools itself; only tools a client must run wait for that client to declare them.
            ...[createCloudAiLocalBashTool(), ...createCloudAiCodeTools()].filter(
              (tool) => tool.location === "server" || config.clientToolIds?.some((name) => name === tool.def.name),
            ),
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

type AttemptOutcome =
  | { kind: "finished"; status: "completed" | "failed" | "aborted"; failure: AiTurnFailureInfo | null; timing?: LoopAggregate["timing"] }
  | { kind: "suspended" };

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
      background: claim.runConfig?.kind !== "compact" && Boolean(claim.runConfig?.background),
      allowRememberedApprovals: aiTurnAllowsRememberedApprovals(claim.runConfig),
    });
    const runConfig = claim.runConfig;
    if (!runConfig) {
      pipeline.seedBaseline(claim.liveBlocks ?? []);
      await pipeline.emitTurnStarted(claim.turn.modelProfileId ?? "");
      await pipeline.emitBaseline();
      await this.finalize(
        conversationId,
        turnId,
        pipeline,
        "failed",
        { error: { code: "failed" }, detail: "AI turn is missing its run configuration." },
        null,
      );
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
        aiTurnFailureFromThrown(error, "AI turn state could not be loaded."),
        "chat",
        claim.runConfig?.kind === "chat" ? claim.runConfig.locale : undefined,
      );
      return;
    }
    pipeline.seedBaseline(rebuildAttemptBaseline(attemptState));
    await pipeline.emitTurnStarted(claim.turn.modelProfileId ?? "");
    await pipeline.emitBaseline();
    await this.runChat(conversationId, turnId, claim, runConfig, pipeline, signal, false, attemptState);
  }

  /**
   * Ends the turn. A failure stores its reason twice: as a code on the turn's last message, which the chat words in
   * the reader's language, and as text in the turn's language for readers without the chat view. The raw cause, such
   * as a provider's own message, goes only to the log. A failed compaction left the chat as it was, so its text names
   * only the reason.
   */
  private async finalize(
    conversationId: string,
    turnId: string,
    pipeline: StreamPipeline,
    status: "completed" | "failed" | "aborted",
    failure: AiTurnFailureInfo | null,
    kind: AiTurnRunConfig["kind"] | null,
    locale?: string,
  ) {
    const failed = status === "failed" ? (failure ?? { error: { code: "failed" as const }, detail: "AI turn failed" }) : null;
    let error: string | null = null;
    if (failed) {
      log.error("AI turn failed", { conversationId, turnId, code: failed.error.code, error: failed.detail });
      error = failed.message ?? null;
      if (!error) {
        const textLocale = normalizeLocale(locale ?? (await coreSettings.get<string>("app.locale")));
        error = kind === "compact" ? aiChatMessages(textLocale).turnErrorReason(failed.error) : aiTurnErrorText(failed.error, textLocale);
      }
    }
    const finalized = await aiConversations.completeTurn({
      conversationId,
      turnId,
      status,
      error,
      turnError: failed?.error ?? null,
      leaseOwner: this.config.leaseOwner,
    });
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
    let allowedTools: string[] | null = null;
    let sourceToolNames: string[] = [];
    try {
      if (config.background && !config.mandate) throw new Error("Background execution requires its task mandate.");
      const [nextMaterial, conversation] = await Promise.all([
        materializeChatConfig(config, abortController.signal, turnId),
        aiConversations.getConversation({ conversationId }),
      ]);
      material = nextMaterial;
      if (!conversation) throw new Error("Conversation is no longer available.");
      allowedTools = conversation.allowedTools ?? null;
      const allowed = allowedTools === null ? null : new Set(allowedTools);
      sourceToolNames = material.tools.map((tool) => tool.def.name);
      if (allowed) material.tools = material.tools.filter((tool) => allowed.has(tool.def.name));
      chatId ||= conversation?.shortId ?? "";
      if (config.project) {
        const subject = accessSubjectForActor(material.actor);
        const project = subject ? await aiProjects.getByShortId(config.project.id, subject, "read") : null;
        if (!project) {
          throw new AiTurnFailure("not_allowed", "Project access is no longer available.");
        }
        resolvedProjectId = project.id;
      }
      if (isAssistantChatTurn(config) && claim.turn.modelProfileId) {
        await aiModelAccess.assertAllowed(claim.turn.modelProfileId, accessSubjectForActor(material.actor));
      }
      validated = await (this.config.validateTurn ?? validateAiTurnRequest)({
        input: config.input,
        hasImageAttachments: config.files?.attached.some((file) => isAiImageMediaType(file.mediaType)),
        canInspectAttachedImages:
          material.tools.some((tool) => tool.def.name === "view_image") &&
          (await isAiVisionModelConfigured(material.modelPolicy?.allowedDataBoundaries)),
        modelPolicy: material.modelPolicy,
        requestedModelId: isAssistantChatTurn(config)
          ? (claim.turn.modelProfileId ?? material.requestedModelId)
          : material.requestedModelId,
      });
      if (isAssistantChatTurn(config)) {
        await aiModelAccess.assertAllowed(validated.resolved.profile.id, accessSubjectForActor(material.actor));
      }
    } catch (error) {
      signal.removeEventListener("abort", onSignal);
      await this.finalize(
        conversationId,
        turnId,
        pipeline,
        "failed",
        aiTurnFailureFromThrown(error, "AI turn failed"),
        "chat",
        config.locale,
      );
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
        {
          error: { code: "not_allowed" },
          detail: error instanceof Error ? error.message : "Cloud capability actor resolution failed",
        },
        "chat",
        config.locale,
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
    const promptLocale = normalizeLocale(config.locale ?? (await coreSettings.get<string>("app.locale")));
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
    const allowed = allowedTools === null ? null : new Set(allowedTools);
    const activeTools = toolsSupported
      ? runtimeTools.filter(
          (tool) => (!allowed || allowed.has(tool.def.name)) && !(config.mandate && ["code_open", "code_secret"].includes(tool.def.name)),
        )
      : [];
    let audioUnavailableInstruction: string | undefined;
    if (
      defaultToolSource &&
      toolsSupported &&
      [...(config.files?.attached ?? []), ...(config.files?.available ?? [])].some((file) => file.mediaType.startsWith("audio/")) &&
      !sourceToolNames.includes("transcribe_audio")
    ) {
      try {
        await resolveAssistantAudioModel(aiChatAccessSubject(config.actor), material.modelPolicy?.allowedDataBoundaries);
      } catch (error) {
        const reason = error instanceof AiTranscriptionError ? error.message : "Audio transcription is not available right now.";
        audioUnavailableInstruction = `Audio files in this conversation cannot be transcribed: ${reason} Tell the user this reason when they ask about audio content.`;
      }
    }
    const offeredToolNames = new Set(activeTools.map((tool) => tool.def.name));
    // Built-ins that exist but this turn does not offer: client tools without their client, tools a
    // task cannot use, and tools outside the conversation's fixed scope. load_tools explains each one.
    const unofferedTools = [
      ...new Set([...sourceToolNames, ...runtimeTools.map((tool) => tool.def.name), ...CODE_RUNTIME_TOOL_NAMES, "local_bash"]),
    ].filter((name) => !offeredToolNames.has(name));
    const memoryToolEnabled = activeTools.some((tool) => tool.def.name === "memory");
    const projectToolEnabled = activeTools.some((tool) => tool.def.name === "search_project");

    if (config.project?.references.length) {
      await indexConversationResources({
        conversationId,
        turnId,
        resources: config.project.references.map((ref) => ({ ref })),
      });
    }

    const approvalTargets = new Map<string, AiApprovalTarget>();
    const dynamicToolRuntimeContext = {
      turnId,
      reportToolProgress: (callId: string, message: string) => pipeline.reportToolProgress(callId, message),
      attachedFilePaths: new Set(config.files?.attached.map((file) => file.path) ?? []),
      allowedDataBoundaries: material.modelPolicy?.allowedDataBoundaries,
      projectFiles,
      skillFiles,
      selectedModel: resolved,
      locale: promptLocale,
      timeZone,
      describeApproval: (approvalCallId: string, target: AiApprovalTarget) => approvalTargets.set(approvalCallId, target),
    };
    const prepared = prepareAiTools({
      tools: activeTools,
      ...dynamicToolRuntimeContext,
      actor: material.actor,
      conversationId,
    });
    let backgroundError: string | null = null;
    const rememberableCapabilityApprovals = new Map<string, string>();
    const capabilityActionReviews = new Map<string, CapabilityActionReview>();
    pipeline.setApprovalTargets(approvalTargets);
    pipeline.setFrontendModes(prepared.frontendModes);
    pipeline.setCanonicalNames(prepared.canonicalNames);
    pipeline.setApprovalPolicies(prepared.approvalPolicies);
    const toolPresentations = new Map<string, AiToolPresentation>();
    const rejectedToolCallIds = new Set<string>();
    const approvedToolCallIds = new Set<string>();
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
        aiTurnFailureFromThrown(error, "Image preparation failed"),
        "chat",
        promptLocale,
      );
      return;
    }
    const store = aiConversations.createSessionStore({
      background: config.background,
      onMessage: async (message) => {
        if (message.message.role === "assistant") await pipeline.timing.finishGeneration();
        await pipeline.emitMessage(message);
      },
      conversationId,
      modelProfileId: resolved.profile.id,
      turnId,
      leaseOwner: this.config.leaseOwner,
      turnInput,
      toolPresentations,
      rejectedToolCallIds,
      approvedToolCallIds,
    });

    const { loopMessages, pendingRecords, resolvedRecords, turnSteers } =
      attemptState ?? (await loadChatAttemptState(conversationId, turnId));
    for (const action of resolvedRecords) {
      if (action.resolvedEvent?.type !== "approval_response") continue;
      // A decision on a custom approval belongs to the call that asked for it.
      const callId = action.kind === "custom_approval" ? (customApprovalParentCallId(action.callId) ?? action.callId) : action.callId;
      (action.resolvedEvent.approved ? approvedToolCallIds : rejectedToolCallIds).add(callId);
    }
    pipeline.setRejectedCallIds(rejectedToolCallIds);
    pipeline.setApprovedCallIds(approvedToolCallIds);
    const assistantMessages = loopMessages.filter((message) => message.message.role !== "user");
    const isFresh = assistantMessages.length === 0 && resolvedRecords.length === 0 && !skipResolvedActions;

    // Rebuild the whole active-turn view so a re-run/continuation reconstructs it.
    if (!attemptState) {
      pipeline.seedBaseline(rebuildAttemptBaseline({ loopMessages, pendingRecords, resolvedRecords, turnSteers }));
      await pipeline.emitTurnStarted(resolved.profile.id);
      await pipeline.emitBaseline();
    }

    const appliedSteers: AiTurnSteer[] = [];

    let mandatePolicy: MandatePolicyV1 | null | undefined;
    if (config.background && config.mandate) {
      mandatePolicy = null;
      try {
        const mandate = await getMandate(config.mandate.id);
        if (mandate && mandate.state === "active" && mandate.revision === config.mandate.revision) {
          mandatePolicy = mandate.policy;
        } else {
          backgroundError = "Scheduled task mandate is unavailable or changed; recreate or update the task.";
        }
      } catch {
        backgroundError = "Scheduled task mandate could not be loaded; retry or update the task.";
      }
    }
    if (backgroundError) {
      signal.removeEventListener("abort", onSignal);
      await this.finalize(
        conversationId,
        turnId,
        pipeline,
        "failed",
        { error: { code: "not_allowed" }, detail: backgroundError, message: backgroundError },
        "chat",
        promptLocale,
      );
      return;
    }
    const authorizeBackground =
      config.background && config.mandate
        ? async (entry: AiCapabilityCatalogEntry, args: unknown) => {
            try {
              await aiChatTasks.authorizeCapability({
                mandate: config.mandate!,
                appId: entry.appId,
                capabilityId: entry.operation.localId,
                kind: entry.kind,
                input: args,
                approval: entry.kind === "action" && "approval" in entry.operation ? entry.operation.approval : undefined,
              });
            } catch (error) {
              if (!(error instanceof AiChatTaskAuthorityError && error.code === "MANDATE_POLICY_DENIED"))
                backgroundError = error instanceof Error ? error.message : "Background capability access denied";
              throw error;
            }
          }
        : undefined;
    const toolStore = config.background ? createRunToolStore(await aiConversations.getLoadedTools({ conversationId })) : aiConversations;
    const tools = toolActor
      ? createAiToolResolver({
          conversationId,
          actor: capabilityAuthority?.actor ?? toolActor,
          staticTools: activeTools,
          allowedTools,
          mandatePolicy,
          unofferedTools,
          runtimeContext: dynamicToolRuntimeContext,
          store: toolStore,
          ...(capabilityAuthority ? { listRegistry: listCapabilities } : {}),
          onCapabilityRegistryError: (error) =>
            log.warn("AI Capability registry unavailable; continuing without app capabilities", {
              error: error instanceof Error ? error.message : String(error),
            }),
          help: createHelpReader,
          locale: promptLocale,
          maxLoadedTools: resolved.profile.maxLoadedTools,
          ...(capabilityAuthority
            ? {
                review: (entry, args, context) =>
                  reviewAiCapability({
                    conversationId,
                    authority: capabilityAuthority!,
                    mandate: config.mandate,
                    locale: promptLocale,
                    entry,
                    args,
                    context,
                  }),
              }
            : {}),
          authorizeBackground,
          onReview: (callId, review) => {
            capabilityActionReviews.set(callId, review);
            if (review.approvalScope) rememberableCapabilityApprovals.set(callId, review.approvalScope);
          },
          ...(capabilityAuthority
            ? {
                execute: async (entry, args, context) => {
                  try {
                    await authorizeBackground?.(entry, args);
                    const result = await executeAiCapability({
                      conversationId,
                      turnId,
                      authority: capabilityAuthority!,
                      mandate: config.mandate,
                      actionApproval:
                        entry.kind === "action" && !("approval" in entry.operation && entry.operation.approval === "none")
                          ? "approved"
                          : undefined,
                      locale: promptLocale,
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
                    if (
                      config.background &&
                      error instanceof AiCapabilityExecutionError &&
                      (error.status === 401 || error.status === 403 || error.code === "ACTION_OUTCOME_UNKNOWN")
                    )
                      backgroundError = error.message;
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

    const loadedSkills = await loadSelectedAiSkills(
      config.selectedSkillIds ?? [],
      turnId,
      skillSubject,
      activeTools.some((tool) => tool.def.name === "load_skill"),
    );
    const chat = await aiConversations.getConversation({ conversationId });
    const workingPlan = chat?.todoPlan;
    const skillCatalogOffered = activeTools.some((tool) => tool.def.name === "load_skill");
    const skillCreatorAvailable = availableSkills.some((skill) => skill.name === "skill-creator");
    // Offer hints and the recent-work summary only guide a fresh turn a person follows; a resumed
    // attempt after an approval or a scheduled run gets neither.
    let guidance: AiTurnGuidance = {};
    if (isFresh && !config.background && defaultToolSource && user && chat) {
      try {
        guidance = await loadAiTurnGuidance(
          {
            chat,
            turnId,
            ownerUserId: user.id,
            input: config.input,
            instructions: [settings.globalInstructions, config.project?.instructions, memory?.text],
            skillOffers: skillCatalogOffered && skillCreatorAvailable && loadedSkills.length === 0,
            memoryOffers: memoryToolEnabled,
            hasAttachments: Boolean(config.files?.attached.length),
          },
          aiConversations,
        );
      } catch (error) {
        log.warn("AI turn guidance unavailable; continuing without it", {
          conversationId,
          turnId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const systemPrompt = composeAiSystemPrompt({
      globalInstructions: settings.globalInstructions,
      loadedSkills,
      turnInstructions: [
        material.systemPrompt,
        audioUnavailableInstruction,
        guidance.offerHint,
        workingPlan
          ? `Current working plan (new todo_write results supersede this):\n${JSON.stringify({ todos: workingPlan.todos })}`
          : undefined,
        ...(allowedTools === null
          ? []
          : [
              `This conversation has a fixed tool scope. Only these task tools may be used: ${allowedTools.join(", ") || "none"}. Discovery cannot widen it. Explain unavailable operations; do not bypass this scope through another conversation or tool.`,
            ]),
      ]
        .filter(Boolean)
        .join("\n\n"),
      chatId,
      project: config.project,
      files: config.files,
      projectToolEnabled,
      skills: skillCatalogOffered ? skillCatalog.skills : undefined,
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
      interactive: !config.background,
      skillCreatorAvailable,
      recentWork: guidance.recentWork,
    });
    // The turn policy counts the whole turn, including rounds that compaction archived.
    const turnMessages = await aiConversations.listTurnMessages({ conversationId, loopId: turnId, includeCompacted: true });
    const turnBlocks = buildBlocksFromMessages(turnMessages);
    const providerNamesByCallId = new Map(
      turnMessages.flatMap(({ message }) =>
        message.role === "assistant"
          ? message.content.flatMap((part) => (part.type === "tool_call" ? [[part.id, part.name] as const] : []))
          : [],
      ),
    );
    const priorToolRounds = toolRoundState(turnMessages);
    const quotaSubject = accessSubjectForActor(material.actor);
    const deadline = claim.turn.deadline ? Date.parse(claim.turn.deadline) : null;
    // The reason a failed turn names: the one the current model call or the turn's own checks gave.
    const failureReason: { current: AiTurnFailureReason | null } = { current: null };
    const remember = (reason: AiTurnFailureReason | null) => {
      failureReason.current = reason;
    };
    const turnPolicy = applyAiTurnPolicy({
      provider: acceptCanonicalToolNames(
        retryTransientProviderErrors(
          rememberProviderErrors(
            answerOpenToolCalls(assistantQuotaProvider(resolved.provider, config, quotaSubject, resolved.profile, turnId, conversationId)),
            remember,
          ),
          {
            deadline,
            delaysMs: this.config.providerRetryDelaysMs,
            onRetry: async ({ retry, delayMs, issue }) => {
              log.warn("AI provider call retried", { conversationId, turnId, retry, delayMs, kind: issue.kind, message: issue.message });
              await pipeline.emitProviderRetry();
            },
          },
        ),
        prepared.canonicalNames,
      ),
      tools,
      maxToolRounds: resolved.profile.maxToolRounds,
      issuedToolRounds: priorToolRounds.issued,
      completedToolRounds: priorToolRounds.completed,
      deadline,
      runBudgetMs: claim.turn.runBudgetMs ?? null,
      finishedToolCalls: turnBlocks
        .slice(turnBlocks.findLastIndex((block) => block.kind === "steer_applied") + 1)
        .flatMap((block) => (block.kind === "tool" ? [{ ...block, name: providerNamesByCallId.get(block.callId) ?? block.name }] : [])),
      onDecision: (decision) =>
        decision.kind === "hint"
          ? log.warn("AI turn got a loop hint", { conversationId, turnId, hints: decision.hints })
          : log.info("AI turn answers without further tools", { conversationId, turnId, reason: decision.reason }),
    });
    const loop = nessi({
      agentId: "cloud",
      loopId: turnId,
      ...(isFresh ? { input: turnInput } : {}),
      provider: turnPolicy.provider,
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
        if (steers.length === 0) return undefined;
        turnPolicy.noteSteering();
        return steers.map((steer) => steer.text);
      },
      tools: async () => {
        try {
          return await turnPolicy.tools();
        } catch (error) {
          remember(aiTurnReasonFromThrown(error));
          throw error;
        }
      },
      ...(turnPolicy.maxTurns === undefined ? {} : { maxTurns: turnPolicy.maxTurns }),
      temperature: resolved.profile.temperature,
      maxOutputTokens: resolved.profile.maxOutputTokens,
      reasoningEffort: resolved.profile.reasoningEffort,
      coalesce: { ms: AI_COALESCE_MS, maxChars: AI_COALESCE_MAX_CHARS },
      compact: config.background
        ? undefined
        : createCloudCompactFn({
            conversationId,
            turnId,
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
      allowRememberedApprovals: aiTurnAllowsRememberedApprovals(config),
      rememberableCapabilityApprovals,
      capabilityActionReviews,
      approvalTargets,
      appliedSteers,
      noteToolRound: turnPolicy.noteToolRound,
      noteToolCall: turnPolicy.noteToolCall,
      failureReason,
      onBackgroundBlocked: (message) => {
        backgroundError = message;
      },
    });
    signal.removeEventListener("abort", onSignal);

    if (outcome.kind === "suspended") {
      log.info("AI turn suspended", { conversationId, turnId, attempt: claim.turn.attempt, durationMs: Date.now() - startedAt });
      await this.config.enqueueContinuation({ conversationId, turnId }).catch(() => undefined);
      await pipeline.flush().catch(() => undefined);
      return;
    }

    // A provider/tool may notice the lost lease before the next heartbeat tick.
    // Resolve the durable cause too, so deadline expiry never looks like a user stop.
    const finalTurn = outcome.status !== "completed" ? await aiConversations.getTurn({ conversationId, turnId }) : null;
    const timeout =
      abortController.signal.reason instanceof AiRunTimeout
        ? abortController.signal.reason
        : finalTurn?.deadline && Date.parse(finalTurn.deadline) <= Date.now() && !finalTurn.cancelRequestedAt
          ? new AiRunTimeout(finalTurn.runBudgetMs ?? null)
          : null;
    if (timeout) {
      outcome.status = "failed";
      outcome.failure = { error: timeout.turnError(), detail: "Run time limit reached." };
    }
    const finalized = await this.finalize(
      conversationId,
      turnId,
      pipeline,
      backgroundError ? "failed" : outcome.status,
      // A background run keeps Cloud's own words for what its mandate blocked.
      backgroundError ? { error: { code: "not_allowed" }, detail: backgroundError, message: backgroundError } : outcome.failure,
      "chat",
      promptLocale,
    );
    if (finalized === "pending_steering" && outcome.status === "completed" && !signal.aborted) {
      await this.runChat(conversationId, turnId, claim, config, pipeline, signal, true);
      return;
    }
    log.info("AI turn finished", {
      conversationId,
      turnId,
      attempt: claim.turn.attempt,
      status: outcome.status,
      cancelled: outcome.status === "aborted",
      durationMs: Date.now() - startedAt,
      firstBlockMs: pipeline.firstBlockMs,
      generationMs: outcome.timing?.generationMs,
      toolMs: outcome.timing?.toolExecutionMs,
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
    allowRememberedApprovals: boolean;
    rememberableCapabilityApprovals: ReadonlyMap<string, string>;
    capabilityActionReviews: ReadonlyMap<string, CapabilityActionReview>;
    approvalTargets: ReadonlyMap<string, AiApprovalTarget>;
    appliedSteers: AiTurnSteer[];
    noteToolRound: () => void;
    noteToolCall: (call: AiTurnPolicyToolCall) => void;
    /**
     * Why the turn would fail now, as a model call or the turn's own checks said. A new model call starts without one,
     * so a context overflow that compaction resolved never names a later failure. Only the model calls and checks set
     * it, in the order they run; the events here arrive later than that.
     */
    failureReason: { current: AiTurnFailureReason | null };
    onBackgroundBlocked?: (message: string) => void;
  }): Promise<AttemptOutcome> {
    const {
      loop,
      pipeline,
      conversationId,
      turnId,
      abortController,
      prepared,
      approvalContext,
      allowRememberedApprovals,
      rememberableCapabilityApprovals,
      capabilityActionReviews,
      approvalTargets,
      appliedSteers,
      noteToolRound,
      noteToolCall,
      failureReason,
    } = input;
    const stopHeartbeat = this.startHeartbeat(conversationId, turnId, abortController);
    let lastIssueMessage: string | null = null;

    try {
      for await (const event of loop) {
        await pipeline.timing.event(event);
        if (event.type === "tool_action_request") {
          const suspended = await this.handleActionRequest({
            event,
            loop,
            pipeline,
            conversationId,
            turnId,
            prepared,
            approvalContext,
            allowRememberedApprovals,
            rememberableCapabilityApprovals,
            capabilityActionReviews,
            approvalTargets,
            onBackgroundBlocked: input.onBackgroundBlocked,
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
            })
            .catch(() => undefined);
          if (!prepared.frontendModes.has(event.name))
            await aiToolAudit
              .noteToolStarted({ conversationId, turnId, callId: event.callId, toolName })
              .catch(() =>
                log.warn("AI tool audit write failed", { code: "tool_audit_start_failed", conversationId, turnId, callId: event.callId }),
              );
        } else if (event.type === "tool_execution_end") {
          await aiToolAudit
            .noteToolCompleted({ turnId, callId: event.callId, isError: event.isError })
            .catch(() => log.warn("AI tool audit write failed", { code: "tool_audit_complete_failed", turnId, callId: event.callId }));
          const toolBlock = pipeline.blocks.find((block) => block.kind === "tool" && block.callId === event.callId);
          // The policy keys calls by the name the model called, as the persisted calls it seeds from.
          noteToolCall(
            toolBlock?.kind === "tool"
              ? { ...toolBlock, name: event.name }
              : { name: event.name, status: event.isError ? "failed" : "completed", result: event.result },
          );
          await indexConversationToolSource({
            conversationId,
            turnId,
            callId: event.callId,
            name: event.name,
            args: toolBlock?.kind === "tool" ? toolBlock.args : undefined,
            result: event.result,
            isError: event.isError === true,
          });
        } else if (event.type === "turn_end" && !abortController.signal.aborted && isToolRound(event.message)) {
          noteToolRound();
        } else if (event.type === "issue") {
          lastIssueMessage = event.issue.message;
          log.warn("AI turn issue", { conversationId, turnId, kind: event.issue.kind, message: event.issue.message });
        } else if (event.type === "loop_end") {
          const aggregate = await withDurableTurnTiming(turnId, event.aggregate);
          if (aggregate.assistantMessageCount > 0) {
            await aiConversations
              .setLatestAssistantLoopAggregate({ conversationId, loopId: turnId, aggregate, doneReason: event.reason })
              .catch(() => undefined);
          }
          const timing = aggregate.timing;
          if (event.reason === "aborted") return { kind: "finished", status: "aborted", failure: null, timing };
          if (event.reason === "stop") return { kind: "finished", status: "completed", failure: null, timing };
          const detail = lastIssueMessage ?? `AI turn ended: ${event.reason}`;
          const reason: AiTurnFailureReason =
            event.reason === "max_turns"
              ? { error: { code: "step_limit" } }
              : event.reason === "context_overflow"
                ? { error: { code: "context_full" } }
                : event.reason === "no_credits"
                  ? { error: { code: "quota_exhausted" } }
                  : (failureReason.current ?? { error: { code: "failed" } });
          return { kind: "finished", status: "failed", failure: { ...reason, detail }, timing };
        }
      }
      return { kind: "finished", status: abortController.signal.aborted ? "aborted" : "completed", failure: null };
    } catch (error) {
      if (abortController.signal.aborted) return { kind: "finished", status: "aborted", failure: null };
      return { kind: "finished", status: "failed", failure: aiTurnFailureFromThrown(error, "AI turn failed") };
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
    allowRememberedApprovals: boolean;
    rememberableCapabilityApprovals: ReadonlyMap<string, string>;
    capabilityActionReviews: ReadonlyMap<string, CapabilityActionReview>;
    approvalTargets: ReadonlyMap<string, AiApprovalTarget>;
    onBackgroundBlocked?: (message: string) => void;
  }): Promise<boolean> {
    const {
      event,
      loop,
      pipeline,
      conversationId,
      turnId,
      prepared,
      approvalContext,
      allowRememberedApprovals,
      rememberableCapabilityApprovals,
      capabilityActionReviews,
      approvalTargets,
    } = input;
    const approvalPolicy = prepared.approvalPolicies.get(event.name);
    const toolName = prepared.canonicalNames.get(event.name) ?? event.name;
    const frontendMode: AiFrontendToolMode | undefined =
      event.kind === "client_tool" ? (prepared.frontendModes.get(event.name) ?? "client") : undefined;
    const capabilityApprovalScope =
      event.kind === "custom_approval"
        ? rememberableCapabilityApprovals.get(customApprovalParentCallId(event.callId) ?? event.callId)
        : undefined;
    // A tool that names what it asks for (a code run's HTTP request or Action, a web page to read) already looked up
    // its own remembered approvals under its own rules; the approval is remembered for that target, not the tool.
    const target = event.kind === "custom_approval" ? approvalTargets.get(event.callId) : undefined;
    const approvalScope = target?.approvalScope ?? capabilityApprovalScope ?? aiToolApprovalScope(toolName, approvalPolicy);
    const allowAlways =
      allowRememberedApprovals && (target ? target.always : capabilityApprovalScope !== undefined || aiToolAllowsAlways(approvalPolicy));
    const allowChat = allowRememberedApprovals && (target !== undefined || allowAlways);

    // Display-only client_view tools (cards, charts) need neither a browser nor input: Cloud answers them itself, in
    // background runs too, whose transcript shows them later. The block goes from running straight to completed:
    // a published awaiting_client would read as an open request to clients and remount the result in the chat.
    // nessi emits no tool_execution_end for client tools, so Cloud ends the call itself.
    if (frontendMode === "client_view") {
      loop.push({ type: "tool_result", callId: event.callId, result: { displayed: true } });
      await pipeline.apply({
        type: "tool_execution_end",
        callId: event.callId,
        name: event.name,
        result: { displayed: true },
        isError: false,
      } as OutboundEvent);
      await aiToolAudit
        .noteToolCompleted({ turnId, callId: event.callId, isError: false })
        .catch(() => log.warn("AI tool audit write failed", { code: "tool_audit_complete_failed", turnId, callId: event.callId }));
      return false;
    }

    const runConfig = await aiConversations.getTurnRunConfig({ conversationId, turnId });
    if (runConfig?.kind !== "compact" && (runConfig?.background || runConfig?.mandate)) {
      input.onBackgroundBlocked?.(
        `Background operation ${toolName} requires ${event.kind === "client_tool" ? "an interactive browser" : "interactive approval"}. Update the task in the normal chat.`,
      );
      if (event.kind === "client_tool")
        loop.push({
          type: "tool_result",
          callId: event.callId,
          result: { error: "This operation requires an interactive browser and is unavailable in a background run." },
        });
      else loop.push({ type: "approval_response", callId: event.callId, approved: false });
      return false;
    }

    // Remembered approvals resolve inline too.
    if (event.kind !== "client_tool" && !target && allowAlways && approvalContext) {
      const remembered = await hasRememberedAiToolApproval(approvalContext, { toolName, approvalScope, conversationId }).catch(() => false);
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
      allowChat,
      ...(target ? { rememberToolName: target.toolName } : {}),
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
          status: "waiting_for_frontend",
        })
        .catch(() => undefined);
    } else {
      await aiToolAudit
        .noteApprovalRequested({ conversationId, turnId, callId: event.callId, toolName, location: "server" })
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
      if (!ok && !stopped) {
        const turn = await aiConversations.getTurn({ conversationId, turnId }).catch(() => null);
        const timedOut = turn?.deadline && Date.parse(turn.deadline) <= Date.now() && !turn.cancelRequestedAt;
        abortController.abort(timedOut ? new AiRunTimeout(turn.runBudgetMs ?? null) : undefined);
      }
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
      await this.finalize(conversationId, turnId, pipeline, "failed", aiTurnFailureFromThrown(error, "AI compaction failed"), "compact");
      return;
    }
    const { settings, resolved } = validated;

    const store = aiConversations.createSessionStore({
      conversationId,
      modelProfileId: resolved.profile.id,
      turnId,
      leaseOwner: this.config.leaseOwner,
    });
    const reason: { current: AiTurnFailureReason | null } = { current: null };
    const loop = compact({
      agentId: "cloud",
      loopId: turnId,
      store,
      provider: rememberProviderErrors(
        inferenceProvider(resolved.provider, resolved.profile, {
          kind: "background",
          task: "chat-compaction",
          conversationId,
          turnId,
          appId: "core",
        }),
        (remembered) => {
          reason.current = remembered;
        },
      ),
      force: true,
      signal: abortController.signal,
      compact: createCloudCompactFn({
        conversationId,
        turnId,
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
    let failure: AiTurnFailureInfo | null = null;
    let issueMessage: string | null = null;
    try {
      for await (const event of loop as AsyncIterable<CompactEvent>) {
        if (event.type === "compaction_start") await pipeline.applyCompaction("running");
        else if (event.type === "compaction_end") await pipeline.applyCompaction("completed");
        else if (event.type === "issue") issueMessage = event.issue.message;
        else if (event.type === "loop_end") {
          status = event.reason === "stop" ? "completed" : event.reason === "aborted" ? "aborted" : "failed";
          await pipeline.applyCompaction(status === "failed" ? "failed" : "completed", event.result);
          if (status === "failed")
            failure = {
              ...(reason.current ?? { error: { code: "failed" } }),
              detail: issueMessage ?? `AI compaction ended: ${event.reason}`,
            };
        }
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        status = "aborted";
      } else {
        status = "failed";
        const thrown = aiTurnFailureFromThrown(err, "AI compaction failed");
        failure = reason.current ? { ...reason.current, detail: thrown.detail } : thrown;
      }
    } finally {
      stopHeartbeat();
      signal.removeEventListener("abort", onSignal);
    }

    if (abortController.signal.reason instanceof AiRunTimeout) {
      status = "failed";
      failure = { error: abortController.signal.reason.turnError(), detail: "Run time limit reached." };
    }
    await this.finalize(conversationId, turnId, pipeline, status, failure, "compact");
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
  private readonly background: boolean;
  private readonly allowRememberedApprovals: boolean;
  readonly timing: ReturnType<typeof createTurnTimingRecorder>;
  private lastSnapshotAt = 0;
  private snapshotDirty = false;
  private snapshotTimer: ReturnType<typeof setTimeout> | undefined;
  /** The newest save of the live state. Saves run one after another, so an older one never lands last. */
  private saving: Promise<void> = Promise.resolve();
  private chain: Promise<void> = Promise.resolve();

  constructor(input: {
    conversationId: string;
    turnId: string;
    attempt: number;
    startSeq: number;
    leaseOwner: string;
    seedBlocks: AiTurnBlock[];
    background?: boolean;
    allowRememberedApprovals: boolean;
  }) {
    this.background = input.background ?? false;
    this.timing = createTurnTimingRecorder(input.turnId);
    this.conversationId = input.conversationId;
    this.turnId = input.turnId;
    this.attempt = input.attempt;
    this.leaseOwner = input.leaseOwner;
    this.seq = input.startSeq;
    this.blocks = [];
    this.allowRememberedApprovals = input.allowRememberedApprovals;
    this.mapper = createEventMapper(input.attempt, input.seedBlocks, input.allowRememberedApprovals);
  }

  private ordered(run: () => Promise<void>): Promise<void> {
    this.chain = this.chain.catch(() => undefined).then(run);
    return this.chain;
  }

  private nextSeq(): number {
    this.seq += 1;
    // The saved state follows every event, so a reader that reloads it catches up with the live stream.
    this.snapshotDirty = true;
    return this.seq;
  }

  private envelope<T extends { type: string }>(event: T): T & { v: 1; conversationId: string; turnId: string; attempt: number } {
    return { ...event, v: 1, conversationId: this.conversationId, turnId: this.turnId, attempt: this.attempt };
  }

  seedBaseline(blocks: AiTurnBlock[]): void {
    this.blocks = this.allowRememberedApprovals
      ? blocks
      : blocks.map((block) =>
          block.kind === "tool" && block.approval
            ? { ...block, approval: { ...block.approval, allowAlways: false, allowChat: false } }
            : block,
        );
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

  setApprovalTargets(targets: ReadonlyMap<string, AiApprovalTarget>): void {
    this.mapper.setApprovalTargets(targets);
  }

  setRejectedCallIds(callIds: Set<string>): void {
    this.mapper.setRejectedCallIds(callIds);
  }

  setApprovedCallIds(callIds: Set<string>): void {
    this.mapper.setApprovedCallIds(callIds);
  }

  async emitBaseline(): Promise<void> {
    for (const block of this.blocks) {
      const seq = this.nextSeq();
      await this.publish(this.envelope({ type: "block_set" as const, seq, block }) as AiWireEvent);
    }
    // A new attempt's baseline is saved at once: a stream that reloads the turn must not wait for the first model event.
    await this.maybeSnapshot();
  }

  async emitMessage(message: AiStoredMessage): Promise<void> {
    const seq = this.nextSeq();
    await this.publish(this.envelope({ type: "message_saved" as const, seq, message }));
    await this.maybeSnapshot();
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

  async reportToolProgress(callId: string, progress: string): Promise<void> {
    const block = this.blocks.find((block) => block.kind === "tool" && block.callId === callId);
    if (!block || block.kind !== "tool" || block.progress === progress) return;
    await this.emitOp({ type: "block_set", block: { ...block, progress } });
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

  /**
   * Saves the live state at most once per interval. A change inside the interval is saved when it ends, even if no
   * event follows, so the saved state lags the live stream by at most one interval.
   */
  private async maybeSnapshot(): Promise<void> {
    if (!this.snapshotDirty) return;
    const wait = AI_LIVE_SNAPSHOT_INTERVAL_MS - (Date.now() - this.lastSnapshotAt);
    if (wait > 0) {
      this.snapshotTimer ??= setTimeout(() => {
        this.snapshotTimer = undefined;
        void this.maybeSnapshot();
      }, wait);
      return;
    }
    await this.persistSnapshot();
  }

  async persistSnapshot(): Promise<void> {
    this.cancelSnapshotTimer();
    this.lastSnapshotAt = Date.now();
    this.snapshotDirty = false;
    const blocks = this.blocks;
    const seq = this.seq;
    this.saving = this.saving.then(() =>
      aiConversations
        .saveTurnLiveState({ conversationId: this.conversationId, turnId: this.turnId, leaseOwner: this.leaseOwner, blocks, seq })
        .then(() => undefined)
        .catch(() => undefined),
    );
    await this.saving;
  }

  /** Transient: says a model call is waiting to be retried. Snapshots never carry it. */
  async emitProviderRetry(): Promise<void> {
    const seq = this.nextSeq();
    await this.publish(this.envelope({ type: "provider_retry" as const, seq }));
    await this.maybeSnapshot();
  }

  async emitTurnFinished(status: "completed" | "failed" | "aborted", error: string | null): Promise<void> {
    const seq = this.nextSeq();
    await this.publish(this.envelope({ type: "turn_finished" as const, seq, status, error }) as AiWireEvent);
  }

  private publish(event: AiWireEvent): Promise<void> {
    if (this.background) return Promise.resolve();
    return this.ordered(() => publishAiWireEvent(event).catch(() => undefined));
  }

  private cancelSnapshotTimer(): void {
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = undefined;
  }

  /**
   * Waits for every publish and save. The attempt ends here: a later save would overwrite what suspension or the next
   * attempt saved.
   */
  async flush(): Promise<void> {
    this.cancelSnapshotTimer();
    await Promise.all([this.chain, this.saving]);
  }
}

export const __aiExecutorTest = {
  indexConversationToolSource,
  StreamPipeline,
  createEventMapper,
  rebuildAttemptBaseline,
  rebuildBlocksFromMessages,
  toolRoundState,
};
