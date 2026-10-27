import { sql } from "bun";
import { toPgTextArray } from "../services/postgres";
import { aiModelCatalog } from "./model-catalog";
import type { AiModelUsage } from "../shared/ai-models";
import { aiPeopleAtLimit } from "./quota-limits";
import { aiQuotas } from "./quotas";

export const aiModelUsage = async (variantIds: string[], modelIds: string[], db = sql): Promise<AiModelUsage> => {
  const ids = toPgTextArray(variantIds);
  const [assignments, projects, workflows, scheduledTasks, counts, stats, config, people] = await Promise.all([
    aiModelCatalog.assignments(db),
    db<
      { id: string; name: string }[]
    >`SELECT short_id AS id,name FROM ai.projects WHERE default_model->>'id'=ANY(${ids}::text[]) ORDER BY name,id`,
    db<
      { id: string; name: string }[]
    >`SELECT w.id,w.name FROM workflows.workflow w JOIN workflows.version v ON v.id=w.active_version_id WHERE EXISTS (SELECT 1 FROM jsonb_path_query(v.plan,'$.**.model.id') ref WHERE ref #>> '{}' = ANY(${ids}::text[])) ORDER BY w.name,w.id`,
    db<
      { id: string; name: string }[]
    >`SELECT task.short_id AS id,left(task.prompt,120) AS name FROM ai.chat_tasks task JOIN ai.conversations c ON c.id=task.conversation_id LEFT JOIN ai.projects p ON p.id=c.project_id WHERE p.default_model->>'id'=ANY(${ids}::text[]) ORDER BY task.id`,
    db<{ chats: number }[]>`SELECT count(DISTINCT conversation_id)::int AS chats FROM ai.turns WHERE model_profile_id=ANY(${ids}::text[])`,
    db<AiModelUsage["stats"][]>`WITH answers AS (
      SELECT COALESCE(turn_id,id) AS answer, CASE WHEN bool_and(cost IS NOT NULL) THEN sum(cost) END AS cost,
        extract(epoch FROM max(finished_at)-min(started_at)) AS seconds
      FROM ai.inference_calls WHERE model_profile_id=ANY(${ids}::text[]) AND started_at>=now()-interval '14 days'
        AND kind='chat' AND status='ok' GROUP BY COALESCE(turn_id,id)
    ) SELECT count(*)::int AS "answers14d", CASE WHEN count(*)>=20 THEN avg(cost)::float8 END AS "avgCostPerAnswer", CASE WHEN count(*)>=20 THEN avg(seconds)::float8 END AS "avgSecondsPerAnswer" FROM answers`,
    aiQuotas.config(db),
    // Count exhausted people per rule, then deduplicate global and model scopes.
    aiPeopleAtLimit(db),
  ]);
  return {
    assignments: assignments
      .filter((assignment) => assignment.variantId && variantIds.includes(assignment.variantId))
      .map((assignment) => assignment.slot),
    projects,
    workflows,
    scheduledTasks,
    chats: counts[0]?.chats ?? 0,
    budgetRules: config.rules.filter((rule) => modelIds.includes(rule.scope)).map((rule) => ({ id: rule.scope, label: rule.scope })),
    peopleAtLimit: new Set(people.filter((rule) => rule.scope === "*" || modelIds.includes(rule.scope)).flatMap((rule) => rule.people))
      .size,
    stats: stats[0] ?? { answers14d: 0, avgCostPerAnswer: null, avgSecondsPerAnswer: null },
  };
};
