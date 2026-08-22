import { sql } from "bun";
import type { CloudResourceRef } from "../contracts/capabilities";
import { withAiShortId } from "./short-id";
import type { AiMemoryKind } from "./memories";

export type AiMemoryLearningRunStatus = "running" | "ok" | "skipped" | "failed";
export type AiMemoryLearningRunKind = "turn" | "workflow";
export type AiMemoryLearningChangeAction = "added" | "updated" | "merged" | "retired";

export type AiMemoryLearningChange = {
  action: AiMemoryLearningChangeAction;
  kind: AiMemoryKind;
  content: string;
  previousContent?: string;
  resourceRef?: CloudResourceRef;
};

export type AiMemoryLearningRun = {
  id: string;
  conversationId: string | null;
  conversationTitle: string;
  kind: AiMemoryLearningRunKind;
  status: AiMemoryLearningRunStatus;
  modelProfileId: string | null;
  durationMs: number | null;
  addedCount: number;
  updatedCount: number;
  mergedCount: number;
  retiredCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  accountedTokens: number;
  changes: AiMemoryLearningChange[];
  error: string | null;
  createdAt: string;
};

export type AiMemoryLearningRunPage = {
  runs: AiMemoryLearningRun[];
  page: number;
  perPage: number;
  total: number;
};

type RunRow = {
  id: string;
  short_id: string;
  conversation_short_id: string | null;
  conversation_title: string;
  run_kind: AiMemoryLearningRunKind;
  status: AiMemoryLearningRunStatus;
  model_profile_id: string | null;
  duration_ms: number | null;
  added_count: number;
  updated_count: number;
  merged_count: number;
  retired_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
  accounted_tokens: number;
  changes: AiMemoryLearningChange[] | string;
  error: string | null;
  created_at: string | Date;
};

const parseChanges = (value: RunRow["changes"]): AiMemoryLearningChange[] => {
  if (Array.isArray(value)) return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as AiMemoryLearningChange[]) : [];
  } catch {
    return [];
  }
};

const toRun = (row: RunRow): AiMemoryLearningRun => ({
  id: row.short_id,
  conversationId: row.conversation_short_id,
  conversationTitle: row.conversation_title,
  kind: row.run_kind,
  status: row.status,
  modelProfileId: row.model_profile_id,
  durationMs: row.duration_ms,
  addedCount: row.added_count,
  updatedCount: row.updated_count,
  mergedCount: row.merged_count,
  retiredCount: row.retired_count,
  inputTokens: row.input_tokens,
  outputTokens: row.output_tokens,
  accountedTokens: row.accounted_tokens,
  changes: parseChanges(row.changes),
  error: row.error,
  createdAt: new Date(row.created_at).toISOString(),
});

const counts = (changes: AiMemoryLearningChange[]) => ({
  added: changes.filter((change) => change.action === "added").length,
  updated: changes.filter((change) => change.action === "updated").length,
  merged: changes.filter((change) => change.action === "merged").length,
  retired: changes.filter((change) => change.action === "retired").length,
});

export const aiMemoryLearningRuns = {
  async start(input: {
    userId: string;
    conversationId: string;
    turnId: string;
    runKind: AiMemoryLearningRunKind;
    evidenceKey?: string;
    modelProfileId: string;
    accountedTokens: number;
  }): Promise<string | null> {
    if ((input.runKind === "workflow") !== Boolean(input.evidenceKey)) {
      throw new Error("Workflow learning runs require one evidence key.");
    }
    const rows = await withAiShortId("idx_ai_memory_learning_runs_short_id", (shortId) =>
      input.runKind === "turn"
        ? sql<{ id: string }[]>`
        INSERT INTO ai.memory_learning_runs (
          short_id, user_id, conversation_id, turn_id, conversation_title, run_kind, model_profile_id, accounted_tokens
        )
        SELECT ${shortId}, ${input.userId}::uuid, c.id, turn.id, c.title, ${input.runKind}, ${input.modelProfileId}, ${input.accountedTokens}
        FROM ai.conversations c
        JOIN ai.turns turn ON turn.conversation_id = c.id AND turn.id = ${input.turnId}::uuid
        WHERE c.id = ${input.conversationId}::uuid AND c.created_by_user_id = ${input.userId}::uuid
        ON CONFLICT (turn_id) WHERE turn_id IS NOT NULL AND run_kind = 'turn'
        DO UPDATE SET
          status = 'running', model_profile_id = EXCLUDED.model_profile_id, duration_ms = NULL,
          accounted_tokens = EXCLUDED.accounted_tokens, error = NULL, completed_at = NULL, created_at = now()
        WHERE ai.memory_learning_runs.status = 'failed'
          OR (ai.memory_learning_runs.status = 'running' AND ai.memory_learning_runs.created_at < now() - interval '30 minutes')
        RETURNING id
      `
        : sql<{ id: string }[]>`
        INSERT INTO ai.memory_learning_runs (
          short_id, user_id, conversation_id, turn_id, conversation_title, run_kind, evidence_key, model_profile_id, accounted_tokens
        )
        SELECT ${shortId}, ${input.userId}::uuid, c.id, turn.id, c.title, 'workflow', ${input.evidenceKey!},
               ${input.modelProfileId}, ${input.accountedTokens}
        FROM ai.conversations c
        JOIN ai.turns turn ON turn.conversation_id = c.id AND turn.id = ${input.turnId}::uuid
        WHERE c.id = ${input.conversationId}::uuid AND c.created_by_user_id = ${input.userId}::uuid
        ON CONFLICT (evidence_key) WHERE evidence_key IS NOT NULL AND run_kind = 'workflow'
        DO UPDATE SET
          status = 'running', model_profile_id = EXCLUDED.model_profile_id, duration_ms = NULL,
          accounted_tokens = EXCLUDED.accounted_tokens, error = NULL, completed_at = NULL, created_at = now()
        WHERE ai.memory_learning_runs.status = 'failed'
          OR (ai.memory_learning_runs.status = 'running' AND ai.memory_learning_runs.created_at < now() - interval '30 minutes')
        RETURNING id
      `,
    );
    return rows[0]?.id ?? null;
  },

  async finish(input: {
    runId: string;
    status: "ok" | "skipped";
    durationMs: number;
    changes: AiMemoryLearningChange[];
    inputTokens?: number;
    outputTokens?: number;
    accountedTokens: number;
  }): Promise<void> {
    const changeCounts = counts(input.changes);
    await sql`
      UPDATE ai.memory_learning_runs
      SET status = ${input.status},
          duration_ms = ${input.durationMs},
          added_count = ${changeCounts.added},
          updated_count = ${changeCounts.updated},
          merged_count = ${changeCounts.merged},
          retired_count = ${changeCounts.retired},
          input_tokens = ${input.inputTokens ?? null},
          output_tokens = ${input.outputTokens ?? null},
          accounted_tokens = ${input.accountedTokens},
          changes = (${JSON.stringify(input.changes)}::text)::jsonb,
          completed_at = now()
      WHERE id = ${input.runId}::uuid
    `;
  },

  async fail(input: { runId: string; durationMs: number; error: string; changes: AiMemoryLearningChange[] }): Promise<void> {
    const changeCounts = counts(input.changes);
    await sql`
      UPDATE ai.memory_learning_runs
      SET status = 'failed',
          duration_ms = ${input.durationMs},
          added_count = ${changeCounts.added},
          updated_count = ${changeCounts.updated},
          merged_count = ${changeCounts.merged},
          retired_count = ${changeCounts.retired},
          changes = (${JSON.stringify(input.changes)}::text)::jsonb,
          error = ${input.error.slice(0, 1_000)},
          completed_at = now()
      WHERE id = ${input.runId}::uuid
    `;
  },

  async list(input: { userId: string; page?: number; perPage?: number }): Promise<AiMemoryLearningRunPage> {
    const page = Math.max(1, input.page ?? 1);
    const perPage = Math.min(50, Math.max(1, input.perPage ?? 20));
    const offset = (page - 1) * perPage;
    const [rows, [count]] = await Promise.all([
      sql<RunRow[]>`
        SELECT
          r.id, r.short_id, c.short_id AS conversation_short_id, r.conversation_title,
          r.run_kind, r.status, r.model_profile_id, r.duration_ms, r.added_count, r.updated_count,
          r.merged_count, r.retired_count, r.input_tokens, r.output_tokens, r.accounted_tokens,
          r.changes, r.error, r.created_at
        FROM ai.memory_learning_runs r
        LEFT JOIN ai.conversations c ON c.id = r.conversation_id AND c.created_by_user_id = r.user_id
        WHERE r.user_id = ${input.userId}::uuid
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ${perPage} OFFSET ${offset}
      `,
      sql<{ total: number }[]>`
        SELECT COUNT(*)::int AS total FROM ai.memory_learning_runs WHERE user_id = ${input.userId}::uuid
      `,
    ]);
    return { runs: rows.map(toRun), page, perPage, total: count?.total ?? 0 };
  },
};
