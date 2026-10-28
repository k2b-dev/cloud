import { sql } from "bun";
import { recursiveGroupIdsSubquery } from "../services/accounts/group-sql";
import { toPgTextArray } from "../services/postgres";
import { hasBillableAiPricing } from "../shared/ai-costs";
import { readAiSettingsState } from "./settings";

/** One row per rule; identities are deduplicated when several model rules apply. */
export const aiPeopleAtLimit = async (db = sql): Promise<{ scope: string; people: string[] }[]> => {
  const priced = [
    ...new Set(
      (await readAiSettingsState()).profiles.filter((profile) => hasBillableAiPricing(profile.pricing)).map((profile) => profile.modelId),
    ),
  ];
  return db<{ scope: string; people: string[] }[]>`WITH rules AS MATERIALIZED (
    SELECT r->>'scope' AS scope,r->'grants' AS grants,
      (r->>'anchor')::timestamptz + floor(extract(epoch FROM (now()-(r->>'anchor')::timestamptz)) / ((r->>'hours')::int*3600)) * ((r->>'hours')::int*interval '1 hour') AS starts
    FROM ai.cost_config,jsonb_array_elements(rules) r WHERE singleton AND enabled
      AND (r->>'scope'='*' OR r->>'scope'=ANY(${toPgTextArray(priced)}::text[]))
  ), people AS MATERIALIZED (
    SELECT u.id FROM auth.users u WHERE EXISTS(SELECT 1 FROM ai.inference_calls WHERE kind='chat' AND user_id=u.id)
      OR EXISTS(SELECT 1 FROM ai.conversations c JOIN ai.turns t ON t.conversation_id=c.id
        WHERE c.created_by_user_id=u.id AND t.run_config->>'assistantChat'='true' AND t.run_config->'mandate' IS NULL)
  ), allowances AS MATERIALIZED (
    SELECT u.id,r.scope,r.starts,CASE WHEN bool_or(g->>'limit' IS NULL) FILTER(WHERE g IS NOT NULL) THEN NULL ELSE COALESCE(max((g->>'limit')::float8),0) END AS amount
    FROM people u CROSS JOIN rules r LEFT JOIN LATERAL (
      SELECT g FROM jsonb_array_elements(r.grants) g WHERE g->'principal'->>'type'='authenticated'
        OR g->'principal'->>'userId'=u.id::text OR (g->'principal'->>'groupId')::uuid IN (${recursiveGroupIdsSubquery(sql`u.id`)})
    ) grants ON true GROUP BY u.id,r.scope,r.starts
  ), exhausted AS (
    SELECT a.scope,a.id FROM allowances a LEFT JOIN ai.inference_calls c ON c.user_id=a.id AND c.kind='chat'
      AND (a.scope='*' OR c.model_id=a.scope) AND c.started_at>=a.starts
      AND c.started_at>COALESCE((SELECT max(created_at) FROM ai.cost_resets z WHERE z.user_id=a.id AND z.scope=a.scope),'-infinity'::timestamptz)
    WHERE a.amount IS NOT NULL AND NOT EXISTS(SELECT 1 FROM allowances w WHERE w.id=a.id AND w.scope='*' AND w.amount IS NULL)
    GROUP BY a.scope,a.id,a.amount HAVING COALESCE(sum(c.cost),0)>=a.amount
  ) SELECT scope,array_agg(id::text ORDER BY id) AS people FROM exhausted GROUP BY scope`;
};
