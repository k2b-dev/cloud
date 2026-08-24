import { sql } from "bun";
import type { AiMessageFeedbackReason } from "./types";

export const AI_USAGE_RANGES = ["24h", "7d", "30d", "90d"] as const;
export type AiUsageRange = (typeof AI_USAGE_RANGES)[number];

export type AiUsageOverview = {
  range: AiUsageRange;
  since: string;
  turns: number;
  responses: number;
  activeUsers: number;
  inputTokens: number;
  outputTokens: number;
  creditsUsed: number | null;
  creditsCoverage: number;
  failedTurns: number;
  positiveFeedback: number;
  negativeFeedback: number;
  launchedChats: number;
  modelSwitches: number;
};

export type AiUsagePoint = { bucket: string; turns: number; tokens: number; failed: number; credits: number | null };
export type AiUsageModel = {
  modelProfileId: string;
  providerModel: string | null;
  turns: number;
  failed: number;
  tokens: number;
  credits: number | null;
  avgGenerationMs: number | null;
  p95GenerationMs: number | null;
  avgOutputTokensPerSecond: number | null;
  positiveFeedback: number;
  negativeFeedback: number;
  switchesAway: number;
};
export type AiUsageUser = {
  userId: string;
  label: string;
  turns: number;
  tokens: number;
  credits: number | null;
  failed: number;
  capabilities: number;
  feedbackGiven: number;
};
export type AiUsageCapability = {
  name: string;
  calls: number;
  failed: number;
  rejected: number;
  avgDurationMs: number | null;
  users: number;
};
export type AiUsageBackgroundTask = {
  appId: string;
  task: string;
  modelProfileId: string | null;
  runs: number;
  failed: number;
  tokens: number;
  credits: number | null;
  avgDurationMs: number | null;
  lastError: string | null;
  lastRunAt: string;
};
export type AiUsageLaunch = { appId: string; chats: number; users: number };
export type AiUsageFeedback = {
  messageId: string;
  conversationId: string;
  conversationTitle: string;
  userLabel: string;
  modelProfileId: string | null;
  rating: "up" | "down";
  reasons: AiMessageFeedbackReason[];
  comment: string | null;
  updatedAt: string;
};
export type AiUsageReport = {
  overview: AiUsageOverview;
  timeline: AiUsagePoint[];
  models: AiUsageModel[];
  users: AiUsageUser[];
  capabilities: AiUsageCapability[];
  backgroundTasks: AiUsageBackgroundTask[];
  launches: AiUsageLaunch[];
  feedback: AiUsageFeedback[];
};

const RANGE_MS: Record<AiUsageRange, number> = {
  "24h": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
  "30d": 30 * 24 * 60 * 60 * 1_000,
  "90d": 90 * 24 * 60 * 60 * 1_000,
};
const number = (value: unknown): number => (typeof value === "number" ? value : Number(value ?? 0));
const nullableNumber = (value: unknown): number | null => (value === null || value === undefined ? null : number(value));
const iso = (value: Date | string): string => new Date(value).toISOString();

type OverviewRow = {
  turns: unknown;
  responses: unknown;
  active_users: unknown;
  input_tokens: unknown;
  output_tokens: unknown;
  credits_used: unknown;
  credits_covered: unknown;
  failed_turns: unknown;
  positive_feedback: unknown;
  negative_feedback: unknown;
  launched_chats: unknown;
  model_switches: unknown;
};

type BackgroundRow = {
  app_id: string | null;
  task: string;
  model_profile_id: string | null;
  runs: unknown;
  failed: unknown;
  tokens: unknown;
  credits: unknown;
  avg_duration_ms: unknown;
  last_error: string | null;
  last_run_at: Date | string;
};

const loadBackgroundRows = async (since: Date): Promise<BackgroundRow[]> => {
  const [relation] = await sql<{ workflow_tasks: string | null }[]>`SELECT to_regclass('ai.workflow_task')::text AS workflow_tasks`;
  if (!relation?.workflow_tasks) {
    return sql<BackgroundRow[]>`
      SELECT COALESCE(app_id, 'core') AS app_id, task, model_profile_id, count(*) AS runs,
        count(*) FILTER (WHERE status = 'failed') AS failed, COALESCE(sum(total_tokens), 0) AS tokens,
        sum(credits_used) AS credits, avg(duration_ms) AS avg_duration_ms,
        (array_agg(error ORDER BY created_at DESC) FILTER (WHERE error IS NOT NULL))[1] AS last_error,
        max(created_at) AS last_run_at
      FROM ai.structured_runs WHERE created_at >= ${since}
      GROUP BY app_id, task, model_profile_id ORDER BY runs DESC LIMIT 100
    `;
  }
  return sql<BackgroundRow[]>`
    WITH background AS (
      SELECT COALESCE(app_id, 'core') AS app_id, task, model_profile_id, status,
        COALESCE(total_tokens, 0)::double precision AS tokens, credits_used AS credits,
        duration_ms::double precision AS duration_ms, error, created_at
      FROM ai.structured_runs WHERE created_at >= ${since}
      UNION ALL
      SELECT app_id, 'workflow.' || kind, model_profile_id,
        CASE WHEN status = 'succeeded' THEN 'ok' ELSE status END,
        COALESCE(NULLIF(usage->>'total', '')::double precision, 0),
        NULLIF(usage->>'creditsUsed', '')::double precision,
        EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000,
        error_message, created_at
      FROM ai.workflow_task WHERE created_at >= ${since}
    )
    SELECT app_id, task, model_profile_id, count(*) AS runs,
      count(*) FILTER (WHERE status = 'failed') AS failed, sum(tokens) AS tokens, sum(credits) AS credits,
      avg(duration_ms) AS avg_duration_ms,
      (array_agg(error ORDER BY created_at DESC) FILTER (WHERE error IS NOT NULL))[1] AS last_error,
      max(created_at) AS last_run_at
    FROM background GROUP BY app_id, task, model_profile_id ORDER BY runs DESC LIMIT 100
  `;
};

export const aiUsage = {
  report: async (range: AiUsageRange = "30d"): Promise<AiUsageReport> => {
    const since = new Date(Date.now() - RANGE_MS[range]);
    const bucket = range === "24h" ? "hour" : "day";
    const [overviewRows, timelineRows, modelRows, userRows, capabilityRows, backgroundRows, launchRows, feedbackRows] = await Promise.all([
      sql<OverviewRow[]>`
        WITH response AS (
          SELECT DISTINCT ON (turn.id)
            turn.id, turn.conversation_id, turn.model_profile_id, turn.status, turn.created_at,
            message.usage, message.loop_aggregate, message.feedback_rating
          FROM ai.turns turn
          LEFT JOIN ai.messages message ON message.conversation_id = turn.conversation_id
            AND message.loop_id = turn.id::text AND message.kind = 'message' AND message.role = 'assistant'
          WHERE turn.created_at >= ${since} AND COALESCE(turn.run_config->>'kind', 'chat') = 'chat'
          ORDER BY turn.id, (message.loop_aggregate IS NOT NULL) DESC, message.seq DESC
        ), ordered AS (
          SELECT model_profile_id, lag(model_profile_id) OVER (PARTITION BY conversation_id ORDER BY created_at, id) AS previous_model
          FROM response
        )
        SELECT
          count(*) AS turns,
          count(*) FILTER (WHERE usage IS NOT NULL OR loop_aggregate IS NOT NULL) AS responses,
          (SELECT count(DISTINCT created_by_user_id) FROM ai.conversations c JOIN response r ON r.conversation_id = c.id) AS active_users,
          COALESCE(sum(COALESCE(NULLIF(loop_aggregate #>> '{usage,input}', '')::double precision, NULLIF(usage->>'input', '')::double precision)), 0) AS input_tokens,
          COALESCE(sum(COALESCE(NULLIF(loop_aggregate #>> '{usage,output}', '')::double precision, NULLIF(usage->>'output', '')::double precision)), 0) AS output_tokens,
          sum(COALESCE(NULLIF(loop_aggregate #>> '{usage,creditsUsed}', '')::double precision, NULLIF(usage->>'creditsUsed', '')::double precision)) AS credits_used,
          count(*) FILTER (WHERE COALESCE(loop_aggregate #>> '{usage,creditsUsed}', usage->>'creditsUsed') IS NOT NULL) AS credits_covered,
          count(*) FILTER (WHERE status = 'failed') AS failed_turns,
          count(*) FILTER (WHERE feedback_rating = 1) AS positive_feedback,
          count(*) FILTER (WHERE feedback_rating = -1) AS negative_feedback,
          (SELECT count(*) FROM ai.conversations WHERE launched_by_app_id IS NOT NULL AND created_at >= ${since}) AS launched_chats,
          (SELECT count(*) FROM ordered WHERE previous_model IS NOT NULL AND model_profile_id IS DISTINCT FROM previous_model) AS model_switches
        FROM response
      `,
      sql<
        {
          bucket: Date | string;
          turns: unknown;
          tokens: unknown;
          failed: unknown;
          credits: unknown;
        }[]
      >`
        WITH response AS (
          SELECT DISTINCT ON (turn.id) turn.id, turn.status, turn.created_at, message.usage, message.loop_aggregate
          FROM ai.turns turn
          LEFT JOIN ai.messages message ON message.conversation_id = turn.conversation_id
            AND message.loop_id = turn.id::text AND message.kind = 'message' AND message.role = 'assistant'
          WHERE turn.created_at >= ${since} AND COALESCE(turn.run_config->>'kind', 'chat') = 'chat'
          ORDER BY turn.id, (message.loop_aggregate IS NOT NULL) DESC, message.seq DESC
        )
        SELECT date_trunc(${bucket}, created_at) AS bucket, count(*) AS turns,
          COALESCE(sum(COALESCE(NULLIF(loop_aggregate #>> '{usage,total}', '')::double precision, NULLIF(usage->>'total', '')::double precision)), 0) AS tokens,
          count(*) FILTER (WHERE status = 'failed') AS failed,
          sum(COALESCE(NULLIF(loop_aggregate #>> '{usage,creditsUsed}', '')::double precision, NULLIF(usage->>'creditsUsed', '')::double precision)) AS credits
        FROM response GROUP BY 1 ORDER BY 1
      `,
      sql<
        {
          model_profile_id: string | null;
          provider_model: string | null;
          turns: unknown;
          failed: unknown;
          tokens: unknown;
          credits: unknown;
          avg_generation_ms: unknown;
          p95_generation_ms: unknown;
          avg_output_tps: unknown;
          positive_feedback: unknown;
          negative_feedback: unknown;
          switches_away: unknown;
        }[]
      >`
        WITH response AS (
          SELECT DISTINCT ON (turn.id) turn.id, turn.conversation_id, turn.model_profile_id, turn.status, turn.created_at,
            message.provider_model, message.usage, message.loop_aggregate, message.feedback_rating
          FROM ai.turns turn
          LEFT JOIN ai.messages message ON message.conversation_id = turn.conversation_id
            AND message.loop_id = turn.id::text AND message.kind = 'message' AND message.role = 'assistant'
          WHERE turn.created_at >= ${since} AND COALESCE(turn.run_config->>'kind', 'chat') = 'chat'
          ORDER BY turn.id, (message.loop_aggregate IS NOT NULL) DESC, message.seq DESC
        ), switches AS (
          SELECT model_profile_id, lead(model_profile_id) OVER (PARTITION BY conversation_id ORDER BY created_at, id) AS next_model
          FROM response
        ), switch_counts AS (
          SELECT model_profile_id, count(*) FILTER (WHERE next_model IS NOT NULL AND next_model IS DISTINCT FROM model_profile_id) AS switches_away
          FROM switches GROUP BY model_profile_id
        )
        SELECT COALESCE(response.model_profile_id, 'unknown') AS model_profile_id, max(provider_model) AS provider_model,
          count(*) AS turns, count(*) FILTER (WHERE status = 'failed') AS failed,
          COALESCE(sum(COALESCE(NULLIF(loop_aggregate #>> '{usage,total}', '')::double precision, NULLIF(usage->>'total', '')::double precision)), 0) AS tokens,
          sum(COALESCE(NULLIF(loop_aggregate #>> '{usage,creditsUsed}', '')::double precision, NULLIF(usage->>'creditsUsed', '')::double precision)) AS credits,
          avg(NULLIF(loop_aggregate #>> '{timing,generationMs}', '')::double precision) AS avg_generation_ms,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY NULLIF(loop_aggregate #>> '{timing,generationMs}', '')::double precision) AS p95_generation_ms,
          avg(NULLIF(loop_aggregate #>> '{timing,outputTokensPerSecond}', '')::double precision) AS avg_output_tps,
          count(*) FILTER (WHERE feedback_rating = 1) AS positive_feedback,
          count(*) FILTER (WHERE feedback_rating = -1) AS negative_feedback,
          max(COALESCE(switch_counts.switches_away, 0)) AS switches_away
        FROM response LEFT JOIN switch_counts ON switch_counts.model_profile_id IS NOT DISTINCT FROM response.model_profile_id
        GROUP BY response.model_profile_id ORDER BY turns DESC
      `,
      sql<
        {
          user_id: string;
          label: string;
          turns: unknown;
          tokens: unknown;
          credits: unknown;
          failed: unknown;
          capabilities: unknown;
          feedback_given: unknown;
        }[]
      >`
        WITH response AS (
          SELECT DISTINCT ON (turn.id) turn.id, turn.conversation_id, turn.status, message.usage, message.loop_aggregate, message.feedback_rating
          FROM ai.turns turn
          LEFT JOIN ai.messages message ON message.conversation_id = turn.conversation_id
            AND message.loop_id = turn.id::text AND message.kind = 'message' AND message.role = 'assistant'
          WHERE turn.created_at >= ${since} AND COALESCE(turn.run_config->>'kind', 'chat') = 'chat'
          ORDER BY turn.id, (message.loop_aggregate IS NOT NULL) DESC, message.seq DESC
        ), calls AS (
          SELECT conversation_id, count(DISTINCT tool_name) FILTER (WHERE position('.' in tool_name) > 0) AS capabilities
          FROM ai.tool_calls WHERE created_at >= ${since} GROUP BY conversation_id
        )
        SELECT c.created_by_user_id AS user_id, COALESCE(NULLIF(u.display_name, ''), NULLIF(u.uid, ''), c.created_by_user_id::text) AS label,
          count(*) AS turns,
          COALESCE(sum(COALESCE(NULLIF(r.loop_aggregate #>> '{usage,total}', '')::double precision, NULLIF(r.usage->>'total', '')::double precision)), 0) AS tokens,
          sum(COALESCE(NULLIF(r.loop_aggregate #>> '{usage,creditsUsed}', '')::double precision, NULLIF(r.usage->>'creditsUsed', '')::double precision)) AS credits,
          count(*) FILTER (WHERE r.status = 'failed') AS failed,
          max(COALESCE(calls.capabilities, 0)) AS capabilities,
          count(*) FILTER (WHERE r.feedback_rating IS NOT NULL) AS feedback_given
        FROM response r JOIN ai.conversations c ON c.id = r.conversation_id
        LEFT JOIN auth.users u ON u.id = c.created_by_user_id LEFT JOIN calls ON calls.conversation_id = c.id
        WHERE c.created_by_user_id IS NOT NULL
        GROUP BY c.created_by_user_id, u.display_name, u.uid ORDER BY turns DESC LIMIT 100
      `,
      sql<
        {
          name: string;
          calls: unknown;
          failed: unknown;
          rejected: unknown;
          avg_duration_ms: unknown;
          users: unknown;
        }[]
      >`
        SELECT tool.tool_name AS name, count(*) AS calls,
          count(*) FILTER (WHERE tool.status = 'failed') AS failed,
          count(*) FILTER (WHERE tool.status = 'rejected') AS rejected,
          avg(EXTRACT(EPOCH FROM (tool.completed_at - tool.started_at)) * 1000) FILTER (WHERE tool.completed_at IS NOT NULL AND tool.started_at IS NOT NULL) AS avg_duration_ms,
          count(DISTINCT conversation.created_by_user_id) AS users
        FROM ai.tool_calls tool JOIN ai.conversations conversation ON conversation.id = tool.conversation_id
        WHERE tool.created_at >= ${since} AND position('.' in tool.tool_name) > 0
        GROUP BY tool.tool_name ORDER BY calls DESC LIMIT 100
      `,
      loadBackgroundRows(since),
      sql<{ app_id: string; chats: unknown; users: unknown }[]>`
        SELECT launched_by_app_id AS app_id, count(*) AS chats, count(DISTINCT created_by_user_id) AS users
        FROM ai.conversations WHERE launched_by_app_id IS NOT NULL AND created_at >= ${since}
        GROUP BY launched_by_app_id ORDER BY chats DESC
      `,
      sql<
        {
          message_id: string;
          conversation_id: string;
          conversation_title: string;
          user_label: string;
          model_profile_id: string | null;
          feedback_rating: number;
          feedback_reasons: AiMessageFeedbackReason[];
          feedback_comment: string | null;
          feedback_updated_at: Date | string;
        }[]
      >`
        SELECT message.short_id AS message_id, conversation.short_id AS conversation_id,
          conversation.title AS conversation_title,
          COALESCE(NULLIF(users.display_name, ''), NULLIF(users.uid, ''), conversation.created_by_user_id::text, 'Deleted user') AS user_label,
          message.model_profile_id, message.feedback_rating, message.feedback_reasons,
          message.feedback_comment, message.feedback_updated_at
        FROM ai.messages message JOIN ai.conversations conversation ON conversation.id = message.conversation_id
        LEFT JOIN auth.users users ON users.id = conversation.created_by_user_id
        WHERE message.feedback_updated_at >= ${since}
        ORDER BY message.feedback_rating ASC, message.feedback_updated_at DESC LIMIT 100
      `,
    ]);

    const overview = overviewRows[0] ?? ({} as OverviewRow);
    const turns = number(overview.turns);
    return {
      overview: {
        range,
        since: since.toISOString(),
        turns,
        responses: number(overview.responses),
        activeUsers: number(overview.active_users),
        inputTokens: number(overview.input_tokens),
        outputTokens: number(overview.output_tokens),
        creditsUsed: nullableNumber(overview.credits_used),
        creditsCoverage: turns > 0 ? number(overview.credits_covered) / turns : 0,
        failedTurns: number(overview.failed_turns),
        positiveFeedback: number(overview.positive_feedback),
        negativeFeedback: number(overview.negative_feedback),
        launchedChats: number(overview.launched_chats),
        modelSwitches: number(overview.model_switches),
      },
      timeline: timelineRows.map((row) => ({
        bucket: iso(row.bucket),
        turns: number(row.turns),
        tokens: number(row.tokens),
        failed: number(row.failed),
        credits: nullableNumber(row.credits),
      })),
      models: modelRows.map((row) => ({
        modelProfileId: row.model_profile_id ?? "unknown",
        providerModel: row.provider_model,
        turns: number(row.turns),
        failed: number(row.failed),
        tokens: number(row.tokens),
        credits: nullableNumber(row.credits),
        avgGenerationMs: nullableNumber(row.avg_generation_ms),
        p95GenerationMs: nullableNumber(row.p95_generation_ms),
        avgOutputTokensPerSecond: nullableNumber(row.avg_output_tps),
        positiveFeedback: number(row.positive_feedback),
        negativeFeedback: number(row.negative_feedback),
        switchesAway: number(row.switches_away),
      })),
      users: userRows.map((row) => ({
        userId: row.user_id,
        label: row.label,
        turns: number(row.turns),
        tokens: number(row.tokens),
        credits: nullableNumber(row.credits),
        failed: number(row.failed),
        capabilities: number(row.capabilities),
        feedbackGiven: number(row.feedback_given),
      })),
      capabilities: capabilityRows.map((row) => ({
        name: row.name,
        calls: number(row.calls),
        failed: number(row.failed),
        rejected: number(row.rejected),
        avgDurationMs: nullableNumber(row.avg_duration_ms),
        users: number(row.users),
      })),
      backgroundTasks: backgroundRows.map((row) => ({
        appId: row.app_id ?? "core",
        task: row.task,
        modelProfileId: row.model_profile_id,
        runs: number(row.runs),
        failed: number(row.failed),
        tokens: number(row.tokens),
        credits: nullableNumber(row.credits),
        avgDurationMs: nullableNumber(row.avg_duration_ms),
        lastError: row.last_error,
        lastRunAt: iso(row.last_run_at),
      })),
      launches: launchRows.map((row) => ({ appId: row.app_id, chats: number(row.chats), users: number(row.users) })),
      feedback: feedbackRows.map((row) => ({
        messageId: row.message_id,
        conversationId: row.conversation_id,
        conversationTitle: row.conversation_title,
        userLabel: row.user_label,
        modelProfileId: row.model_profile_id,
        rating: row.feedback_rating === 1 ? "up" : "down",
        reasons: row.feedback_reasons,
        comment: row.feedback_comment,
        updatedAt: iso(row.feedback_updated_at),
      })),
    };
  },
};
