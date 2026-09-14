import { sql } from "bun";
import { buildAccessPrincipalCondition, type AccessSubject } from "../server/services/access";
import { AiQuotaConfigSchema, type AiQuotaConfig, type AiQuotaSnapshot, type AiQuotaIdentity } from "../shared/ai-quotas";

export class AiQuotaError extends Error {
  constructor(
    public code: "quota_exhausted" | "quota_usage_unknown" | "quota_conflict",
    message: string,
  ) {
    super(message);
  }
}
const ids = (s: AccessSubject) => ({
  user: s.type === "user" ? s.userId : null,
  service: s.type === "service_account" ? s.serviceAccountId : null,
});
export const quotaWindow = (anchor: string, hours: number, now: Date) => {
  const width = hours * 3_600_000,
    start = Date.parse(anchor);
  const from = start + Math.floor((now.getTime() - start) / width) * width;
  return { from: new Date(from), until: new Date(from + width) };
};
export const aiQuotas = {
  async config(): Promise<AiQuotaConfig> {
    const [row] = await sql<
      { enabled: boolean; revision: number; rules: AiQuotaConfig["rules"] }[]
    >`SELECT enabled,revision,rules FROM ai.quota_config WHERE singleton`;
    return row ?? { enabled: false, revision: 0, rules: [] };
  },
  async save(input: AiQuotaConfig, actorId: string) {
    const config = AiQuotaConfigSchema.parse(input);
    return sql.begin(async (db) => {
      const [old] = await db<{ revision: number }[]>`SELECT revision FROM ai.quota_config WHERE singleton FOR UPDATE`;
      if (!old || old.revision !== config.revision)
        throw new AiQuotaError("quota_conflict", "Quota settings changed. Reload before saving.");
      const revision = config.revision + 1;
      await db`UPDATE ai.quota_config SET enabled=${config.enabled},revision=${revision},rules=(${JSON.stringify(config.rules)}::text)::jsonb WHERE singleton`;
      await db`INSERT INTO ai.quota_changes(revision,actor_id,config) VALUES(${revision},${actorId}::uuid,(${JSON.stringify(config)}::text)::jsonb)`;
      return { ...config, revision };
    });
  },
  async snapshot(subject: AccessSubject, model?: string, now = new Date()): Promise<AiQuotaSnapshot> {
    const config = await aiQuotas.config();
    const identity = ids(subject);
    const matches = buildAccessPrincipalCondition({
      subject,
      columns: {
        userId: sql`NULLIF(g->'principal'->>'userId','')::uuid`,
        groupId: sql`NULLIF(g->'principal'->>'groupId','')::uuid`,
        serviceAccountId: sql`NULLIF(g->'principal'->>'serviceAccountId','')::uuid`,
        authenticatedOnly: sql`(g->'principal'->>'type'='authenticated')`,
      },
    });
    const balances: AiQuotaSnapshot["balances"] = [];
    for (const rule of config.rules.filter((r) => !model || r.scope === "*" || r.scope === model)) {
      const grants = await sql<{ limit: number | null; principal: Record<string, string>; label: string }[]>`
        SELECT (g->>'limit')::float8 AS limit, g->'principal' AS principal,
          COALESCE(u.display_name,u.uid,gr.name,sa.name,'Authenticated users') AS label
        FROM jsonb_array_elements((${JSON.stringify(rule.grants)}::text)::jsonb) g
        LEFT JOIN auth.users u ON u.id=NULLIF(g->'principal'->>'userId','')::uuid
        LEFT JOIN auth.groups gr ON gr.id=NULLIF(g->'principal'->>'groupId','')::uuid
        LEFT JOIN auth.service_accounts sa ON sa.id=NULLIF(g->'principal'->>'serviceAccountId','')::uuid
        WHERE ${matches}`;
      const limit = grants.some((g) => g.limit === null) ? null : Math.max(0, ...grants.map((g) => g.limit ?? 0));
      const window = quotaWindow(rule.anchor, rule.hours, now);
      const [counts] = await sql<{ input: number; output: number; unknown: number }[]>`
        SELECT COALESCE(sum(c.input),0)::float8 AS input, COALESCE(sum(c.output),0)::float8 AS output,
          count(*) FILTER(WHERE (c.input IS NULL OR c.output IS NULL) AND
            (c.finished_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM ai.turns t WHERE t.id=c.turn_id AND t.attempt=c.turn_attempt AND t.status='running' AND t.lease_expires_at > now())))::int AS unknown
        FROM ai.quota_calls c
        WHERE c.user_id IS NOT DISTINCT FROM ${identity.user}::uuid AND c.service_account_id IS NOT DISTINCT FROM ${identity.service}::uuid
          AND (${rule.scope}='*' OR c.model_profile_id=${rule.scope})
          AND c.started_at>=${window.from} AND c.started_at<${window.until}
          AND c.started_at>COALESCE((SELECT max(r.created_at) FROM ai.quota_resets r
            WHERE r.user_id IS NOT DISTINCT FROM ${identity.user}::uuid AND r.service_account_id IS NOT DISTINCT FROM ${identity.service}::uuid AND r.scope=${rule.scope}),'-infinity'::timestamptz)`;
      balances.push({
        scope: rule.scope,
        limit,
        input: counts?.input ?? 0,
        output: counts?.output ?? 0,
        used: (counts?.input ?? 0) + (counts?.output ?? 0),
        unknown: counts?.unknown ?? 0,
        resetsAt: window.until.toISOString(),
        sources: grants.filter((g) => g.limit === limit).map((g) => g.label),
        bypassed: false,
      });
    }
    const unlimited = balances.some((b) => b.scope === "*" && b.limit === null);
    for (const b of balances) b.bypassed = !config.enabled || (unlimited && b.scope !== "*");
    const usage = await sql<
      { model: string; input: number; output: number; unknown: number }[]
    >`SELECT model_profile_id AS model,COALESCE(sum(input),0)::float8 AS input,COALESCE(sum(output),0)::float8 AS output,count(*) FILTER(WHERE finished_at IS NOT NULL AND input IS NULL)::int AS unknown FROM ai.quota_calls
      WHERE user_id IS NOT DISTINCT FROM ${identity.user}::uuid AND service_account_id IS NOT DISTINCT FROM ${identity.service}::uuid
      GROUP BY model_profile_id ORDER BY model_profile_id`;
    return { enabled: config.enabled, balances, usage };
  },
  async assertAllowed(subject: AccessSubject, model: string) {
    // Fast default path: no additional identity/usage queries on unrestricted installations.
    const config = await aiQuotas.config();
    if (!config.enabled || !config.rules.some((r) => r.scope === "*" || r.scope === model)) return false;
    const snapshot = await aiQuotas.snapshot(subject, model);
    for (const b of snapshot.balances) {
      if (b.bypassed || b.limit === null) continue;
      if (b.unknown)
        throw new AiQuotaError(
          "quota_usage_unknown",
          "Chat usage could not be measured. Contact an administrator or wait for the quota reset.",
        );
      if (b.used >= b.limit) throw new AiQuotaError("quota_exhausted", `Chat token limit reached. Resets at ${b.resetsAt}.`);
    }
    return snapshot.balances.some((b) => !b.bypassed && b.limit !== null);
  },
  async begin(subject: AccessSubject, model: string, turnId: string): Promise<string> {
    const identity = ids(subject),
      id = crypto.randomUUID();
    await sql`INSERT INTO ai.quota_calls(id,user_id,service_account_id,model_profile_id,turn_id,turn_attempt)
      VALUES(${id}::uuid,${identity.user}::uuid,${identity.service}::uuid,${model},${turnId}::uuid,(SELECT attempt FROM ai.turns WHERE id=${turnId}::uuid))`;
    return id;
  },
  async finish(id: string, usage?: { input: number; output: number }) {
    // Provider events are snapshots. Finalizing twice must not double charge or erase usage.
    await sql`UPDATE ai.quota_calls SET input=${usage?.input ?? null},output=${usage?.output ?? null},finished_at=clock_timestamp()
      WHERE id=${id}::uuid AND finished_at IS NULL`;
  },
  async reset(subject: AccessSubject, scope: string, requestId: string, actorId: string) {
    const identity = ids(subject);
    await sql.begin(async (db) => {
      // The unique key makes transport retries safe; do not accept reuse for another target.
      await db`INSERT INTO ai.quota_resets(request_id,user_id,service_account_id,scope,actor_id)
        VALUES(${requestId}::uuid,${identity.user}::uuid,${identity.service}::uuid,${scope},${actorId}::uuid) ON CONFLICT DO NOTHING`;
      const [row] = await db`SELECT 1 FROM ai.quota_resets WHERE request_id=${requestId}::uuid AND scope=${scope}
        AND user_id IS NOT DISTINCT FROM ${identity.user}::uuid AND service_account_id IS NOT DISTINCT FROM ${identity.service}::uuid AND actor_id=${actorId}::uuid`;
      if (!row) throw new AiQuotaError("quota_conflict", "Reset request was already used for another target.");
    });
  },
  async users(search: string, page: number): Promise<{ items: AiQuotaIdentity[]; total: number; page: number; perPage: number }> {
    const source = sql`SELECT 'user'::text AS type,u.id,COALESCE(NULLIF(u.display_name,''),u.uid) AS label,
        (SELECT max(started_at) FROM ai.quota_calls WHERE user_id=u.id) AS last_used
      FROM auth.users u WHERE (${search}<>'' OR EXISTS(SELECT 1 FROM ai.quota_calls WHERE user_id=u.id) OR EXISTS(SELECT 1 FROM ai.conversations c JOIN ai.turns t ON t.conversation_id=c.id WHERE c.created_by_user_id=u.id AND t.run_config->>'assistantChat'='true' AND t.run_config->'mandate' IS NULL))
      UNION ALL SELECT 'service_account',s.id,s.name,(SELECT max(started_at) FROM ai.quota_calls WHERE service_account_id=s.id)
      FROM auth.service_accounts s WHERE (${search}<>'' OR EXISTS(SELECT 1 FROM ai.quota_calls WHERE service_account_id=s.id))`;
    const filtered = sql`SELECT * FROM (${source}) users WHERE position(lower(${search}) in lower(label))>0 OR id::text=${search}`;
    const [count] = await sql<{ total: number }[]>`SELECT count(*)::int AS total FROM (${filtered}) q`;
    const total = count?.total ?? 0,
      perPage = 25,
      current = Math.min(page, Math.max(1, Math.ceil(total / perPage)));
    const items = await sql<
      AiQuotaIdentity[]
    >`SELECT type,id,label,last_used::text AS "lastUsed" FROM (${filtered}) q ORDER BY last_used DESC NULLS LAST,label,id LIMIT ${perPage} OFFSET ${(current - 1) * perPage}`;
    return { items, total, page: current, perPage };
  },
};
