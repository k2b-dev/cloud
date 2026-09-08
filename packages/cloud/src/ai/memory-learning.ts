import { sql } from "bun";
import { createHash } from "node:crypto";
import { z } from "zod";
import { CloudResourceRefSchema } from "../contracts/capabilities";
import { coreSettings } from "../services";
import { logger } from "../services/logging";
import { normalizeLocale } from "../shared/locale";
import { parseAiAttachmentMarkers } from "./attachments";
import { type AiMemoryLearningChange, aiMemoryLearningRuns } from "./memory-learning-runs";
import {
  listAiPendingWorkflowPatterns,
  listAiTurnWorkflowEvidence,
  markAiWorkflowPatternReviewed,
  type AiMemoryWorkflowEvidence,
  type AiMemoryWorkflowPattern,
} from "./memory-workflow-evidence";
import { type AiBackgroundMemoryProposal, aiMemories } from "./memories";
import { aiConversations } from "./store";
import type { RunAiStructuredInput, RunAiStructuredResult } from "./structured";
import { resolveAiBackgroundModel, runAiStructured } from "./structured";
import { AI_MEMORY_LEARNING_INSTRUCTIONS_SETTING_KEY, buildAiTaskPrompt } from "./task-prompt";
import type { AiResolvedModel, AiStoredMessage } from "./types";

const DEFAULT_BATCH_LIMIT = 10;
const WORKFLOW_PATTERN_LIMIT = 3;
const USER_TEXT_MAX_CHARS = 6_000;
const FINAL_ASSISTANT_MAX_CHARS = 1_500;
const WORKFLOW_EXAMPLE_MAX_CHARS = 2_000;
const MAX_OUTPUT_TOKENS = 700;
export const AI_MEMORY_LEARNING_MONTHLY_TOKEN_BUDGET_SETTING_KEY = "ai.memory_learning_monthly_token_budget";
export const AI_MEMORY_LEARNING_DEFAULT_MONTHLY_TOKEN_BUDGET = 100_000;

export const AiMemoryLearningChangeSchema = z.object({
  action: z.enum(["add", "replace", "merge", "retire"]),
  kind: z.enum(["fact", "preference", "workflow"]),
  content: z.string().max(500),
  memoryIds: z.array(z.string().min(1).max(12)).max(5),
  resourceRef: CloudResourceRefSchema.nullable(),
});

export const AiLearnedMemoriesSchema = z.object({ changes: z.array(AiMemoryLearningChangeSchema).max(5) });
export type AiLearnedMemories = z.infer<typeof AiLearnedMemoriesSchema>;

const AiWorkflowPatternSchema = z.object({
  workflow: z
    .object({
      content: z.string().min(1).max(500),
      memoryIds: z.array(z.string().min(1).max(12)).max(5),
    })
    .nullable(),
});

type Candidate = {
  conversationId: string;
  turnId: string;
  userId: string;
  completedAsOf: string;
  failCount: number;
  locale?: string | null;
};

type TurnEvidence = {
  candidate: Candidate;
  messages: AiStoredMessage[];
  userText: string;
  finalAssistantText: string;
  userMessageId?: string;
  actions: AiMemoryWorkflowEvidence[];
};

type MemoryLearningDeps = {
  structured?: <TOutput extends z.ZodType>(input: RunAiStructuredInput<TOutput>) => Promise<RunAiStructuredResult<TOutput>>;
  resolveModel?: () => Promise<AiResolvedModel>;
  listCandidates?: (limit: number, monthlyTokenBudget: number) => Promise<Candidate[]>;
  readAdditionalInstructions?: () => Promise<string>;
  listWorkflowPatterns?: (limit: number) => Promise<AiMemoryWorkflowPattern[]>;
  monthlyTokenBudget?: number;
  readMonthlyAccountedTokens?: (userId: string) => Promise<number>;
  readDefaultLocale?: () => Promise<string>;
};

export type AiMemoryLearningRunSummary = {
  scanned: number;
  learned: number;
  updated: number;
  retired: number;
  skipped: number;
  failed: number;
};

const log = logger("ai:memory-learning");

export const MEMORY_LEARNING_PROMPT = [
  "Maintain a small, useful personal profile from one newly completed private chat turn.",
  "The normal result is no changes. Keep only durable information likely to help in multiple future chats.",
  "Facts and preferences require an explicit statement in NEW USER TEXT. Do not infer them from Assistant text or actions.",
  "A workflow links a recurring request type to one Cloud resource. Add one from this turn only when the user explicitly establishes a lasting routing rule and the matching resource appears in SUCCESSFUL ACTIONS.",
  "FINAL ASSISTANT MARKDOWN may clarify what happened, but it is model-written context and never evidence by itself.",
  "Exclude secrets, credentials, sensitive inferences, temporary plans, task details, quoted or attached content, and facts already owned by Contacts, Spaces, Notebooks, or another Cloud resource.",
  "Use replace for one clearly corrected mutable memory, merge for two or more overlapping mutable memories, and retire only when the user explicitly makes mutable background information obsolete.",
  "Protected memories are context only. Never replace, merge, or retire them.",
  "Examples: 'Always answer briefly in German' adds a preference. 'Use Accounting for invoice mail' plus a successful mail.mailbox ref adds a workflow. 'Find this invoice in Accounting' does not establish a lasting workflow.",
].join("\n");

export const MEMORY_LEARNING_OUTPUT_CONTRACT = [
  "Return exactly {changes:[...]} with at most five changes.",
  "add uses no memoryIds; replace uses one; merge uses two or more; retire uses one or more and empty content.",
  "fact and preference use resourceRef null. workflow uses exactly one resourceRef from SUCCESSFUL ACTIONS.",
  "Use only mutable memory ids shown in the input. Return an empty changes array when uncertain.",
].join("\n");

export const WORKFLOW_PATTERN_PROMPT = [
  "Decide whether three successful uses of the same Cloud capability and resource reveal one reusable workflow default.",
  "Return a workflow only when the user requests share a clear recurring category and defaulting to this resource would avoid a future search or clarification.",
  "Do not generalize from unrelated requests, resource contents, or the Assistant wording. Uncertainty returns null.",
  "If an existing mutable workflow is corrected, return its id. Return multiple ids only when one new workflow genuinely consolidates them. Protected memories cannot be changed.",
].join("\n");

export const WORKFLOW_PATTERN_OUTPUT_CONTRACT =
  "Return exactly {workflow:null} or {workflow:{content,memoryIds}}. Content is one short reusable rule; memoryIds contains only shown mutable ids.";

const boundedText = (value: string, maxChars: number): string => {
  const text = value.trim();
  if (text.length <= maxChars) return text;
  const half = Math.floor((maxChars - 30) / 2);
  return `${text.slice(0, half).trimEnd()}\n[...truncated...]\n${text.slice(-half).trimStart()}`;
};

export const listAiMemoryLearningCandidates = async (limit: number, monthlyTokenBudget: number): Promise<Candidate[]> => {
  return sql<Candidate[]>`
    WITH monthly_usage AS (
      SELECT run.user_id, COALESCE(sum(run.accounted_tokens), 0)::bigint AS used_tokens
      FROM ai.memory_learning_runs run
      WHERE run.created_at >= date_trunc('month', now())
      GROUP BY run.user_id
    ), eligible AS (
      SELECT
        conversation.id AS conversation_id,
        turn.id AS turn_id,
        conversation.created_by_user_id AS user_id,
        turn.completed_at,
        turn.memory_learn_fail_count,
        turn.run_config->>'locale' AS locale,
        row_number() OVER (
          PARTITION BY conversation.created_by_user_id
          ORDER BY turn.completed_at ASC, turn.id ASC
        ) AS user_rank
      FROM ai.turns turn
      JOIN ai.conversations conversation ON conversation.id = turn.conversation_id
      JOIN ai.user_prefs prefs ON prefs.user_id = conversation.created_by_user_id
      LEFT JOIN monthly_usage usage ON usage.user_id = conversation.created_by_user_id
      WHERE conversation.created_by_user_id IS NOT NULL
        AND conversation.archived_at IS NULL
        AND prefs.memory_learning_enabled = TRUE
        AND turn.status = 'completed'
        AND COALESCE(turn.run_config->>'kind', 'chat') = 'chat'
        AND turn.memory_learned_at IS NULL
        AND COALESCE(usage.used_tokens, 0) < ${monthlyTokenBudget}
        AND (
          turn.memory_learn_failed_at IS NULL
          OR turn.memory_learn_failed_at + (interval '5 minutes' * pow(2, LEAST(turn.memory_learn_fail_count, 7))) < now()
        )
    )
    SELECT
      conversation_id AS "conversationId",
      turn_id AS "turnId",
      user_id AS "userId",
      completed_at::text AS "completedAsOf",
      memory_learn_fail_count AS "failCount",
      locale
    FROM eligible
    WHERE user_rank <= 5
    ORDER BY completed_at ASC, turn_id ASC
    LIMIT ${Math.min(Math.max(limit, 1), 100)}
  `;
};

const markLearned = async (candidate: Candidate): Promise<void> => {
  await sql`
    UPDATE ai.turns
    SET memory_learned_at = ${candidate.completedAsOf}::timestamptz,
        memory_learn_failed_at = NULL,
        memory_learn_fail_count = 0
    WHERE id = ${candidate.turnId}::uuid
      AND conversation_id = ${candidate.conversationId}::uuid
  `;
};

const markFailed = async (candidate: Candidate): Promise<void> => {
  await sql`
    UPDATE ai.turns
    SET memory_learn_failed_at = now(), memory_learn_fail_count = memory_learn_fail_count + 1
    WHERE id = ${candidate.turnId}::uuid
      AND conversation_id = ${candidate.conversationId}::uuid
  `;
};

const learningEnabled = async (userId: string): Promise<boolean> => {
  const [row] = await sql<{ enabled: boolean }[]>`
    SELECT COALESCE(memory_learning_enabled, FALSE) AS enabled
    FROM ai.user_prefs
    WHERE user_id = ${userId}::uuid
  `;
  return Boolean(row?.enabled);
};

const monthlyAccountedTokens = async (userId: string): Promise<number> => {
  const [row] = await sql<{ tokens: number }[]>`
    SELECT COALESCE(sum(accounted_tokens), 0)::int AS tokens
    FROM ai.memory_learning_runs
    WHERE user_id = ${userId}::uuid AND created_at >= date_trunc('month', now())
  `;
  return row?.tokens ?? 0;
};

export const buildMemoryLearningTranscript = (messages: AiStoredMessage[]): string =>
  messages
    .flatMap((stored) => {
      const message = stored.message;
      if (
        stored.kind !== "message" ||
        message.role !== "user" ||
        stored.meta?.agentMessage ||
        stored.meta?.scheduledTask
      )
        return [];
      return message.content.flatMap((part) => {
        if (typeof part === "string") return part.trim() ? [part.trim()] : [];
        if (part.type !== "text") return [];
        const text = parseAiAttachmentMarkers(part.text).text.trim();
        if (!text || text.startsWith("[Attached Cloud resource ")) return [];
        return [text];
      });
    })
    .join("\n\n");

export const buildFinalAssistantMarkdown = (messages: AiStoredMessage[]): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]?.message;
    if (message?.role !== "assistant") continue;
    const text = message.content.flatMap((part) => (part.type === "text" && part.text.trim() ? [part.text.trim()] : [])).join("\n\n");
    if (text) return text;
  }
  return "";
};

const loadTurnEvidence = async (candidate: Candidate): Promise<TurnEvidence> => {
  const [messages, actions] = await Promise.all([
    aiConversations.listTurnMessages({ conversationId: candidate.conversationId, loopId: candidate.turnId, includeCompacted: true }),
    listAiTurnWorkflowEvidence(candidate.userId, candidate.turnId),
  ]);
  const firstUser = messages.find(
    (message) => message.message.role === "user" && !message.meta?.agentMessage && !message.meta?.scheduledTask,
  );
  return {
    candidate,
    messages,
    userText: boundedText(buildMemoryLearningTranscript(messages), USER_TEXT_MAX_CHARS),
    finalAssistantText: boundedText(buildFinalAssistantMarkdown(messages), FINAL_ASSISTANT_MAX_CHARS),
    userMessageId: firstUser?.id,
    actions,
  };
};

const memoryLines = (memories: Awaited<ReturnType<typeof aiMemories.list>>): string =>
  memories.length > 0
    ? memories
        .map((memory) => {
          const mutability = memory.source === "background" && memory.priority === "normal" ? "mutable" : "protected";
          const resource = memory.resourceRef ? ` | ${memory.resourceRef.type}:${memory.resourceRef.id}` : "";
          return `- ${memory.shortId} | ${mutability} | ${memory.kind} | ${memory.content}${resource}`;
        })
        .join("\n")
    : "(none)";

const actionLines = (actions: AiMemoryWorkflowEvidence[]): string =>
  actions.length > 0
    ? actions
        .map(
          (action) =>
            `- ${action.capabilityId} | ${action.resourceRef.type}:${action.resourceRef.id}${
              action.resourceTitle ? ` | ${action.resourceTitle}` : ""
            }`,
        )
        .join("\n")
    : "(none)";

const learningInput = (evidence: TurnEvidence, memories: Awaited<ReturnType<typeof aiMemories.list>>): string =>
  [
    "NEW USER TEXT:",
    evidence.userText || "(none)",
    "",
    "SUCCESSFUL ACTIONS:",
    actionLines(evidence.actions),
    "",
    "FINAL ASSISTANT MARKDOWN (context only):",
    evidence.finalAssistantText || "(none)",
    "",
    "ACTIVE MEMORIES:",
    memoryLines(memories),
  ].join("\n");

const estimatedTokens = (systemPrompt: string, taskInput: string): number =>
  new TextEncoder().encode(systemPrompt + taskInput).byteLength + MAX_OUTPUT_TOKENS;

const workflowEvidenceKey = (pattern: AiMemoryWorkflowPattern): string =>
  createHash("sha256")
    .update(JSON.stringify([pattern.userId, pattern.capabilityId, pattern.resourceRef.type, pattern.resourceRef.id, ...[...pattern.turnIds].sort()]))
    .digest("hex");

const toProposal = (change: z.infer<typeof AiMemoryLearningChangeSchema>): AiBackgroundMemoryProposal => ({
  action: change.action,
  kind: change.kind,
  content: change.content,
  memoryIds: change.memoryIds,
  resourceRef: change.resourceRef,
});

const applyChanges = async (
  evidence: TurnEvidence,
  changes: z.infer<typeof AiMemoryLearningChangeSchema>[],
  mutableMemoryIds: ReadonlySet<string>,
): Promise<AiMemoryLearningChange[]> => {
  const applied: AiMemoryLearningChange[] = [];
  for (const change of changes) {
    if (change.memoryIds.some((memoryId) => !mutableMemoryIds.has(memoryId))) continue;
    if (
      change.resourceRef &&
      !evidence.actions.some(
        (action) => action.resourceRef.type === change.resourceRef?.type && action.resourceRef.id === change.resourceRef.id,
      )
    ) continue;
    const results = await aiMemories.applyBackgroundProposal({
      userId: evidence.candidate.userId,
      sourceConversationId: evidence.candidate.conversationId,
      sourceMessageId: evidence.userMessageId,
      proposal: toProposal(change),
    });
    applied.push(...results);
  }
  return applied;
};

const workflowPatternInput = async (
  pattern: AiMemoryWorkflowPattern,
): Promise<{ input: string; source: TurnEvidence | null; mutableMemoryIds: Set<string> }> => {
  const sources = await Promise.all(
    pattern.turnIds.map(async (turnId) => {
      const [row] = await sql<{ conversation_id: string; completed_as_of: string; fail_count: number }[]>`
        SELECT turn.conversation_id, turn.completed_at::text AS completed_as_of, turn.memory_learn_fail_count AS fail_count
        FROM ai.turns turn
        JOIN ai.conversations conversation ON conversation.id = turn.conversation_id
        WHERE turn.id = ${turnId}::uuid AND conversation.created_by_user_id = ${pattern.userId}::uuid
      `;
      if (!row) return null;
      return loadTurnEvidence({
        conversationId: row.conversation_id,
        turnId,
        userId: pattern.userId,
        completedAsOf: row.completed_as_of,
        failCount: row.fail_count,
      });
    }),
  );
  const evidence = sources.filter((source): source is TurnEvidence => Boolean(source));
  const query = evidence.map((source) => source.userText).join(" ");
  const selected = await aiMemories.selectHot(pattern.userId, query);
  const examples = evidence
    .map(
      (source, index) =>
        `EXAMPLE ${index + 1}\nUser: ${boundedText(source.userText, WORKFLOW_EXAMPLE_MAX_CHARS)}\nFinal Assistant context: ${
          boundedText(source.finalAssistantText, 500) || "(none)"
        }`,
    )
    .join("\n\n");
  return {
    source: evidence[0] ?? null,
    mutableMemoryIds: new Set(
      selected.memories
        .filter((memory) => memory.source === "background" && memory.priority === "normal")
        .map((memory) => memory.shortId),
    ),
    input: [
      `CAPABILITY: ${pattern.capabilityId}`,
      `RESOURCE: ${pattern.resourceRef.type}:${pattern.resourceRef.id}${pattern.resourceTitle ? ` | ${pattern.resourceTitle}` : ""}`,
      "",
      examples,
      "",
      "ACTIVE MEMORIES:",
      memoryLines(selected.memories),
    ].join("\n"),
  };
};

const usageNumbers = (usage: RunAiStructuredResult<z.ZodType>["usage"], reserved: number) => {
  const inputTokens = usage?.input;
  const outputTokens = usage?.output;
  const total = usage?.total ?? (inputTokens !== undefined || outputTokens !== undefined ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined);
  return { inputTokens, outputTokens, accountedTokens: total ?? reserved };
};

export const learnAiMemoriesFromPrivateChats = async (
  input: { limit?: number; signal?: AbortSignal; heartbeat?: () => Promise<void>; deps?: MemoryLearningDeps } = {},
): Promise<AiMemoryLearningRunSummary> => {
  const summary: AiMemoryLearningRunSummary = { scanned: 0, learned: 0, updated: 0, retired: 0, skipped: 0, failed: 0 };
  let resolved: AiResolvedModel;
  try {
    resolved = await (input.deps?.resolveModel ?? resolveAiBackgroundModel)();
  } catch (error) {
    log.info("Memory learning skipped: no background model available", {
      error: error instanceof Error ? error.message : String(error),
    });
    return summary;
  }

  const configuredBudget =
    input.deps?.monthlyTokenBudget ??
    Number(await coreSettings.get<number>(AI_MEMORY_LEARNING_MONTHLY_TOKEN_BUDGET_SETTING_KEY));
  const monthlyTokenBudget =
    Number.isFinite(configuredBudget) && configuredBudget > 0
      ? Math.floor(configuredBudget)
      : AI_MEMORY_LEARNING_DEFAULT_MONTHLY_TOKEN_BUDGET;
  const batchLimit = Math.min(Math.max(input.limit ?? DEFAULT_BATCH_LIMIT, 1), 100);
  const candidateReadLimit = Math.min(batchLimit * 5, 100);
  const candidates = await (input.deps?.listCandidates ?? listAiMemoryLearningCandidates)(candidateReadLimit, monthlyTokenBudget);
  const readMonthlyUsage = input.deps?.readMonthlyAccountedTokens ?? monthlyAccountedTokens;
  const structured = input.deps?.structured ?? runAiStructured;
  const additionalInstructions = await (
    input.deps?.readAdditionalInstructions ??
    (() => coreSettings.get<string>(AI_MEMORY_LEARNING_INSTRUCTIONS_SETTING_KEY).then((value) => value ?? ""))
  )();
  let defaultLocale: Promise<string> | undefined;
  const resolveLearningLocale = (locale?: string | null): Promise<string> => {
    if (locale) return Promise.resolve(normalizeLocale(locale));
    defaultLocale ??= (input.deps?.readDefaultLocale ?? (() => coreSettings.get<string>("app.locale")))().then(
      normalizeLocale,
    );
    return defaultLocale;
  };

  let processedCandidates = 0;
  for (const candidate of candidates) {
    if (processedCandidates >= batchLimit) break;
    if (input.signal?.aborted) break;
    summary.scanned += 1;
    const startedAt = Date.now();
    let runId: string | null = null;
    let changes: AiMemoryLearningChange[] = [];
    try {
      if (!(await learningEnabled(candidate.userId))) continue;
      const evidence = await loadTurnEvidence(candidate);
      if (!evidence.userText) {
        await markLearned(candidate);
        summary.skipped += 1;
        processedCandidates += 1;
        continue;
      }
      const selected = await aiMemories.selectHot(candidate.userId, evidence.userText);
      const taskInput = learningInput(evidence, selected.memories);
      const locale = await resolveLearningLocale(candidate.locale);
      const systemPrompt = buildAiTaskPrompt({
        baseInstructions: `${MEMORY_LEARNING_PROMPT}\nWrite new or changed memory content in the language identified by locale ${locale}.`,
        additionalInstructions,
        outputContract: MEMORY_LEARNING_OUTPUT_CONTRACT,
      });
      const reservedTokens = estimatedTokens(systemPrompt, taskInput);
      if ((await readMonthlyUsage(candidate.userId)) + reservedTokens > monthlyTokenBudget) continue;
      runId = await aiMemoryLearningRuns.start({
        userId: candidate.userId,
        conversationId: candidate.conversationId,
        turnId: candidate.turnId,
        runKind: "turn",
        modelProfileId: resolved.profile.id,
        accountedTokens: reservedTokens,
      });
      if (!runId) continue;
      const result = await structured({
        task: "memory-learn-turn",
        attribution: { userId: candidate.userId, conversationId: candidate.conversationId, turnId: candidate.turnId },
        appId: "ai",
        systemPrompt,
        input: taskInput,
        output: AiLearnedMemoriesSchema,
        outputName: "personalization_changes",
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        signal: input.signal,
        resolveModel: async () => resolved,
      });
      if (!(await learningEnabled(candidate.userId))) {
        await markLearned(candidate);
      } else {
        changes = await applyChanges(
          evidence,
          result.output.changes,
          new Set(
            selected.memories
              .filter((memory) => memory.source === "background" && memory.priority === "normal")
              .map((memory) => memory.shortId),
          ),
        );
        await markLearned(candidate);
      }
      const status = changes.length > 0 ? "ok" : "skipped";
      await aiMemoryLearningRuns.finish({
        runId,
        status,
        durationMs: Date.now() - startedAt,
        changes,
        ...usageNumbers(result.usage, reservedTokens),
      });
      summary.learned += changes.filter((change) => change.action === "added").length;
      summary.updated += changes.filter((change) => change.action === "updated" || change.action === "merged").length;
      summary.retired += changes.filter((change) => change.action === "retired").length;
      if (status === "skipped") summary.skipped += 1;
      processedCandidates += 1;
    } catch (error) {
      summary.failed += 1;
      processedCandidates += 1;
      await markFailed(candidate).catch(() => undefined);
      if (runId) {
        await aiMemoryLearningRuns
          .fail({ runId, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error), changes })
          .catch(() => undefined);
      }
      log.warn("Memory turn learning failed", {
        conversationId: candidate.conversationId,
        turnId: candidate.turnId,
        failCount: candidate.failCount + 1,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await input.heartbeat?.();
  }

  const patterns = await (input.deps?.listWorkflowPatterns ?? listAiPendingWorkflowPatterns)(WORKFLOW_PATTERN_LIMIT);
  for (const pattern of patterns) {
    if (input.signal?.aborted) break;
    let runId: string | null = null;
    const startedAt = Date.now();
    try {
      if (!(await learningEnabled(pattern.userId))) continue;
      const context = await workflowPatternInput(pattern);
      if (!context.source) {
        await markAiWorkflowPatternReviewed(pattern);
        continue;
      }
      const locale = await resolveLearningLocale(context.source.candidate.locale);
      const workflowPrompt = buildAiTaskPrompt({
        baseInstructions: `${WORKFLOW_PATTERN_PROMPT}\nWrite new or changed workflow content in the language identified by locale ${locale}.`,
        additionalInstructions,
        outputContract: WORKFLOW_PATTERN_OUTPUT_CONTRACT,
      });
      const reservedTokens = estimatedTokens(workflowPrompt, context.input);
      if ((await readMonthlyUsage(pattern.userId)) + reservedTokens > monthlyTokenBudget) continue;
      runId = await aiMemoryLearningRuns.start({
        userId: pattern.userId,
        conversationId: context.source.candidate.conversationId,
        turnId: context.source.candidate.turnId,
        runKind: "workflow",
        evidenceKey: workflowEvidenceKey(pattern),
        modelProfileId: resolved.profile.id,
        accountedTokens: reservedTokens,
      });
      if (!runId) continue;
      const result = await structured({
        task: "memory-learn-workflow",
        attribution: { userId: pattern.userId, conversationId: context.source.candidate.conversationId, turnId: context.source.candidate.turnId },
        appId: "ai",
        systemPrompt: workflowPrompt,
        input: context.input,
        output: AiWorkflowPatternSchema,
        outputName: "workflow_pattern",
        maxOutputTokens: 300,
        signal: input.signal,
        resolveModel: async () => resolved,
      });
      let changes: AiMemoryLearningChange[] = [];
      if (result.output.workflow && (await learningEnabled(pattern.userId))) {
        const memoryIds = result.output.workflow.memoryIds;
        const action = memoryIds.length > 1 ? "merge" : memoryIds.length === 1 ? "replace" : "add";
        changes = await applyChanges(context.source, [
          {
            action,
            kind: "workflow",
            content: result.output.workflow.content,
            memoryIds,
            resourceRef: pattern.resourceRef,
          },
        ], context.mutableMemoryIds);
      }
      await markAiWorkflowPatternReviewed(pattern);
      await aiMemoryLearningRuns.finish({
        runId,
        status: changes.length > 0 ? "ok" : "skipped",
        durationMs: Date.now() - startedAt,
        changes,
        ...usageNumbers(result.usage, reservedTokens),
      });
      summary.learned += changes.filter((change) => change.action === "added").length;
      summary.updated += changes.filter((change) => change.action === "updated" || change.action === "merged").length;
      if (changes.length === 0) summary.skipped += 1;
    } catch (error) {
      summary.failed += 1;
      if (runId) {
        await aiMemoryLearningRuns
          .fail({ runId, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error), changes: [] })
          .catch(() => undefined);
      }
      log.warn("Memory workflow learning failed", {
        capabilityId: pattern.capabilityId,
        resourceType: pattern.resourceRef.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await input.heartbeat?.();
  }

  return summary;
};
