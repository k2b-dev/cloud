import {
  type AiUsageFeedback,
  type AiUsageGroup,
  type AiUsageLaunch,
  type AiUsagePage,
  type AiUsagePoint,
  type AiUsageReportParts,
  type AiUsageRun,
  type AiUsageStats,
  aiQuotas,
  aiUsage,
  quotaAdminConfig,
  quotaReport,
} from "@k2b/cloud/ai/admin";
import { type AiModel, AiQuotaReportQuerySchema, type AiUsageQuery, AiUsageQuerySchema } from "@k2b/cloud/shared";
import type { AiPageInput } from "./page-input";

type UsageCompare = "users" | "models";

/**
 * The parts of the report one view shows, and no other: the overview its figures, charts and side tables, a
 * comparison the figures and its one table, Feedback the chat figures and the ratings, Runs the runs. Every other
 * view is a link to its own address, which the server renders with its own parts.
 */
export type AiUsageViewData =
  | {
      kind: "overview";
      overview: AiUsageStats;
      chat: AiUsageStats;
      background: AiUsageStats;
      timeline: AiUsagePoint[];
      apps: AiUsagePage<AiUsageGroup>;
      workflows: AiUsagePage<AiUsageGroup>;
      launches: AiUsagePage<AiUsageLaunch>;
      unassignedBackgroundRuns: number;
    }
  | { kind: "comparisons"; overview: AiUsageStats; rows: AiUsagePage<AiUsageGroup> }
  | { kind: "feedback"; chat: AiUsageStats; feedback: AiUsagePage<AiUsageFeedback> }
  | { kind: "runs"; runs: AiUsagePage<AiUsageRun> };

const readView = async (parts: AiUsageReportParts, compare: UsageCompare): Promise<AiUsageViewData> => {
  switch (parts.query.view) {
    case "overview": {
      const [overview, chat, background, timeline, apps, workflows, launches, unassignedBackgroundRuns] = await Promise.all([
        parts.summary(),
        parts.summary("chat"),
        parts.summary("background"),
        parts.timeline(),
        parts.groups("apps"),
        parts.groups("workflows"),
        parts.launches(),
        parts.unassignedBackgroundRuns(),
      ]);
      return { kind: "overview", overview, chat, background, timeline, apps, workflows, launches, unassignedBackgroundRuns };
    }
    case "comparisons": {
      const [overview, rows] = await Promise.all([parts.summary(), parts.groups(compare)]);
      return { kind: "comparisons", overview, rows };
    }
    case "feedback": {
      const [chat, feedback] = await Promise.all([parts.summary("chat"), parts.feedback()]);
      return { kind: "feedback", chat, feedback };
    }
    case "runs":
      return { kind: "runs", runs: await parts.runs() };
  }
};

/**
 * The usage explorer for the filters in the address, with only the open view's parts of the report; `null` when the
 * address holds no valid filters. Which table the comparison shows (`compare=models`) and the open run or rating
 * (`run`, `rating`) stay in the address too; the open entry is one of the view's rows, so it needs no read of its own.
 */
export const loadAiUsage = async (input: AiPageInput) => {
  const parsed = AiUsageQuerySchema.safeParse(input.query);
  if (!parsed.success) return null;
  const compare: UsageCompare = input.query.compare === "models" ? "models" : "users";
  const parts = aiUsage.parts(parsed.data.range, parsed.data);
  const [view, unit, userLabel] = await Promise.all([readView(parts, compare), parts.unit(), parts.userLabel()]);
  const query: AiUsageQuery = parts.query;
  return {
    report: { query, since: parts.since, until: parts.until, unit },
    view,
    /** The name of the person the `userId` filter names, for the filter bar. */
    userLabel,
    compare,
    open: { run: input.query.run ?? null, feedback: input.query.feedback ?? null },
    timeZone: input.dates.timeZone,
  };
};

/**
 * Use per person under Budgets: the budget configuration, the models a rule names, the people report, and for the
 * person the address names (`identity`, `identityType`) their current allowances, read on the server like the rest.
 * The models are the catalog the page read for the request.
 */
export const loadAiPeople = async (input: AiPageInput, models: AiModel[]) => {
  const query = AiQuotaReportQuerySchema.safeParse({ ...input.query, view: "users" });
  const identity = query.success ? query.data.identity : undefined;
  const type = query.success ? query.data.identityType : "user";
  const [config, report, balance] = await Promise.all([
    quotaAdminConfig(),
    quotaReport({ ...input.query, view: "users" }),
    identity
      ? aiQuotas
          .snapshot(type === "user" ? { type: "user", userId: identity } : { type: "service_account", serviceAccountId: identity })
          .catch(() => null)
      : Promise.resolve(null),
  ]);
  return {
    config,
    models: models.map((model) => ({
      id: model.id,
      label: model.label,
      pricing: model.pricing ?? undefined,
      enabled: model.enabled,
      capabilities: model.kind === "transcription" ? ["transcription"] : [...model.capabilities],
    })),
    report,
    balance,
    timeZone: input.dates.timeZone,
  };
};

export type AiUsageData = NonNullable<Awaited<ReturnType<typeof loadAiUsage>>>;
export type AiPeopleData = Awaited<ReturnType<typeof loadAiPeople>>;
