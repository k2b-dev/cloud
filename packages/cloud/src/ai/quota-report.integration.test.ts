import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { databaseSuite, testInfra, useMigratedDatabase } from "../../../../scripts/fixtures/test-infra";
import { sql } from "../runtime/clients";
import { toPgUuidArray } from "../services/postgres";
import type { AiQuotaRule } from "../shared/ai-quotas";
import { explainQuotaReport, quotaReport } from "./quota-report";
import * as modelSettings from "./settings";
import type { AiModelProfile } from "./types";

/**
 * The people report reads only the calls of the time it shows: the period and the current rule periods. Years of
 * older calls change neither its figures nor its reads, and no statement scans the whole call table.
 */

const suite = databaseSuite();
let database: Awaited<ReturnType<typeof useMigratedDatabase>> | undefined;
afterAll(async () => {
  await database?.drop();
});

const NOW = new Date("2026-09-20T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (ago: number) => new Date(NOW.getTime() - ago);
const people = Array.from({ length: 40 }, (_, index) => ({
  id: `d4000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  uid: `quota-report-${index}`,
  display_name: `Quota Person ${index}`,
}));
const service = "d4000000-0000-4000-8000-000000000999";
/** Used only long ago: its last use lies before every period the report shows. */
const resting = people[39]!;
// One rule over 30 days whose current period began ten days before NOW; the report shows the last 24 hours.
const rule: AiQuotaRule = {
  scope: "*",
  hours: 720,
  anchor: at(10 * DAY).toISOString(),
  grants: [{ principal: { type: "authenticated" }, limit: 100 }],
};
const priced: AiModelProfile = {
  modelId: "quota-a",
  providerId: "quota",
  variantLabel: "Standard",
  description: "",
  icon: { kind: "provider" },
  showInPicker: true,
  id: "quota-a",
  label: "Quota A",
  provider: "openai",
  model: "quota-a",
  capabilities: [],
  enabled: true,
  dataBoundary: "hosted",
  pricing: { inputPerMillion: 1, outputPerMillion: 2 },
};

/** `count` finished chat (and every fourth background) calls per person, `from` to `from + span` before NOW. */
const insertCalls = (persons: typeof people, count: number, from: number, span: number, cost: number) =>
  sql`INSERT INTO ai.inference_calls(id,user_id,model_profile_id,model_id,provider_model,kind,task,started_at,finished_at,lease_expires_at,input,output,pricing,cost,status)
    SELECT gen_random_uuid(),p.id,'quota-a','quota-a','quota-a:latest',CASE WHEN n%4=0 THEN 'background' ELSE 'chat' END,'chat',
      ${NOW}::timestamptz-${from}*interval '1 millisecond'-(n::float8/${count})*${span}*interval '1 millisecond',
      ${NOW}::timestamptz-${from}*interval '1 millisecond'-(n::float8/${count})*${span}*interval '1 millisecond'+interval '2 seconds',
      ${NOW}::timestamptz-${from}*interval '1 millisecond',800,200,'{"inputPerMillion":1,"outputPerMillion":2}'::jsonb,${cost},'ok'
    FROM unnest(${toPgUuidArray(persons.map((person) => person.id))}::uuid[]) p(id), generate_series(1,${count}) n`;

type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Index Cond"?: string;
  Filter?: string;
  "Subplan Name"?: string;
  Plans?: PlanNode[];
};
const PlanNodeSchema: z.ZodType<PlanNode> = z.lazy(() =>
  z.object({
    "Node Type": z.string(),
    "Relation Name": z.string().optional(),
    "Index Name": z.string().optional(),
    "Index Cond": z.string().optional(),
    Filter: z.string().optional(),
    "Subplan Name": z.string().optional(),
    Plans: z.array(PlanNodeSchema).optional(),
  }),
);
const PlanSchema = z.array(z.object({ Plan: PlanNodeSchema, "Execution Time": z.number() })).length(1);
const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodes)];
const explain = async () => {
  const [plan] = PlanSchema.parse(await explainQuotaReport({ range: "24h" }, NOW));
  const all = nodes(plan!.Plan);
  return {
    seqScans: all.flatMap((node) => (node["Node Type"] === "Seq Scan" && node["Relation Name"] ? [node["Relation Name"]] : [])),
    // A bitmap index scan names its index but not its table.
    callIndexes: [
      ...new Set(all.flatMap((node) => (node["Index Name"]?.startsWith("inference_calls") ? [node["Index Name"]] : []))),
    ].sort(),
    /** How each read of the call table runs, for the log. */
    callReads: all.flatMap((node) =>
      node["Relation Name"] === "inference_calls" || node["Index Name"]?.startsWith("inference_calls")
        ? [[node["Node Type"], node["Index Name"] ?? "", node["Index Cond"] ?? node.Filter ?? ""].join(" · ")]
        : [],
    ),
    executionMs: plan!["Execution Time"],
  };
};

beforeAll(async () => {
  if (!testInfra.database) return;
  database = await useMigratedDatabase("ai_quota_report");
  spyOn(modelSettings, "readAiSettingsState").mockResolvedValue({
    assignments: [],
    ok: true,
    enabled: true,
    globalInstructions: "",
    localClientInstructions: "",
    compactionInstructions: "",
    maxToolResultChars: 1000,
    firecrawlConfigured: false,
    profiles: [priced],
  });
  await sql`INSERT INTO auth.users(id,uid,provider,profile,display_name)
    SELECT id,uid,'local','user',display_name FROM jsonb_to_recordset(${JSON.stringify(people)}::text::jsonb) AS p(id uuid,uid text,display_name text)`;
  await sql`UPDATE ai.cost_config SET enabled=true,unit='EUR',rules=${JSON.stringify([rule])}::text::jsonb WHERE singleton`;
  // A year of history before the rule period: 1,500 calls per person, three quarters of them chat.
  await insertCalls(people, 1500, 30 * DAY, 335 * DAY, 0.5);
  // In the rule period but before the report's 24 hours, and inside them.
  const active = people.filter((person) => person !== resting);
  await insertCalls(active, 4, 5 * DAY, DAY, 0.25);
  await insertCalls(active, 4, HOUR, 6 * HOUR, 0.125);
  // A service account with a year of chat calls and one in the last 24 hours, and a year of background calls without
  // a person (system tasks), the rows an index on "no user" would walk.
  await sql`INSERT INTO auth.service_accounts(id,name,kind) VALUES(${service}::uuid,'Quota Service','agent')`;
  await sql`INSERT INTO ai.inference_calls(id,user_id,service_account_id,model_profile_id,model_id,provider_model,kind,task,started_at,finished_at,lease_expires_at,input,output,pricing,cost,status)
    SELECT gen_random_uuid(),NULL,CASE WHEN n%10=0 THEN ${service}::uuid END,'quota-a','quota-a','quota-a:latest',CASE WHEN n%10=0 THEN 'chat' ELSE 'background' END,'task',
      ${NOW}::timestamptz-(CASE WHEN n=10 THEN 2 ELSE 48 + n END)*interval '1 hour',${NOW}::timestamptz-(CASE WHEN n=10 THEN 2 ELSE 48 + n END)*interval '1 hour'+interval '2 seconds',
      ${NOW}::timestamptz,800,200,'{"inputPerMillion":1,"outputPerMillion":2}'::jsonb,0.5,'ok' FROM generate_series(1,20000) n`;
  await sql`ANALYZE ai.inference_calls`;
}, 180_000);

suite("AI quota report: the period it shows, not the history (integration)", () => {
  test("figures, balances and last use match the calls of their own period", async () => {
    const report = await quotaReport({ range: "24h", search: "Quota Person" }, NOW);
    expect(report.total).toBe(40);
    // 39 people with three chat calls each in the last 24 hours (every fourth call is background).
    expect(report.overview).toMatchObject({ accounts: 39, calls: 117, cost: 14.625 });
    const first = (await quotaReport({ range: "24h", search: people[0]!.display_name }, NOW)).items[0];
    expect(first).toMatchObject({ id: people[0]!.id, calls: 3, cost: 0.375, status: "available" });
    // The rule period holds the six chat calls of the last ten days (3 × 0.25 + 3 × 0.125), never the year before.
    expect(first?.balances).toEqual([{ scope: "*", limit: 100, used: 1.125, unknown: 0, bypassed: false }]);
    const [last] = await sql<
      { at: Date }[]
    >`SELECT max(started_at) AS at FROM ai.inference_calls WHERE user_id=${resting.id}::uuid AND kind='chat'`;
    const restingRow = (await quotaReport({ range: "24h", search: resting.display_name }, NOW)).items[0];
    // The last use is the real one, a month and more ago, though no period the report reads holds it.
    expect(restingRow).toMatchObject({ id: resting.id, calls: 0, cost: null });
    expect(Math.abs(Date.parse(restingRow?.lastUsed ?? "") - last!.at.getTime())).toBeLessThan(1);
    expect(restingRow?.balances).toEqual([{ scope: "*", limit: 100, used: 0, unknown: 0, bypassed: false }]);
    // The service account: one chat call in the period, ten days of them in its balance, its last use two hours ago.
    const machine = (await quotaReport({ range: "24h", search: "Quota Service" }, NOW)).items[0];
    expect(machine).toMatchObject({ id: service, type: "service_account", calls: 1, cost: 0.5, lastUsed: at(2 * HOUR).toISOString() });
    // Its chat calls in the rule period: the one two hours ago and those 68 to 238 hours ago (n = 20 … 190), 19 in all.
    expect(machine?.balances).toEqual([{ scope: "*", limit: 100, used: 9.5, unknown: 0, bypassed: false }]);
  });

  test("the plan reads calls by index only: no sequential scan of the call table", async () => {
    const plan = await explain();
    console.log(JSON.stringify(plan));
    expect(plan.seqScans).not.toContain("inference_calls");
    // The calls of the shown time by their start, each account's last use by its own index, never all calls of "no user".
    expect(plan.callIndexes).toEqual(["inference_calls_service", "inference_calls_started", "inference_calls_user"]);
    expect(plan.callReads.filter((read) => read.includes("user_id IS NULL"))).toEqual([]);
  });

  test("the report sends a fixed number of statements, however long the history", async () => {
    const meter = await meterSql();
    try {
      await quotaReport({ range: "24h" }, NOW);
      const before = await meter.during(() => quotaReport({ range: "24h" }, NOW));
      await insertCalls(people, 500, 400 * DAY, 300 * DAY, 0.5);
      await sql`ANALYZE ai.inference_calls`;
      const after = await meter.during(() => quotaReport({ range: "24h" }, NOW));
      console.log(JSON.stringify({ before, after }));
      // The transaction, its JIT setting and the one report statement; the model prices (settings) are stubbed here.
      expect(before.length).toBe(4);
      expect(after.length).toBe(before.length);
      expect(before.filter((statement) => statement.includes("inference_calls") || statement.startsWith("WITH"))).toHaveLength(1);
    } finally {
      await meter.close();
    }
    const plan = await explain();
    console.log(JSON.stringify(plan));
    expect(plan.seqScans).not.toContain("inference_calls");
    expect(plan.callReads.filter((read) => read.includes("user_id IS NULL"))).toEqual([]);
  });
});
