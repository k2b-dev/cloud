import { coreClient } from "@k2b/cloud/clients/core";
import {
  AI_USAGE_RANGES,
  AI_USAGE_REASONS,
  type AiUsageQuery,
  AiUsageQuerySchema,
  aiUsageSearchParams,
  principalLabel,
} from "@k2b/cloud/shared";
import { defineListQuery, field, type ListQueryStateOf, type LookupItem } from "@k2b/ui/v2/list-query";
import { aiUsageMessages } from "../settings/_components/ai-usage-messages";

type Messages = ReturnType<typeof aiUsageMessages.resolve>["t"];
type Facet = "userId" | "modelId" | "providerModel" | "appId" | "task";

/** The parameters the filter bar writes; every other parameter (view, sort, page, until) the page keeps itself. */
export const USAGE_FILTER_KEYS = [
  "range",
  "userId",
  "modelId",
  "providerModel",
  "appId",
  "rating",
  "reason",
  "kind",
  "status",
  "task",
  "errorCode",
  "search",
] as const satisfies readonly (keyof AiUsageQuery)[];

export const usageReasonLabel = (t: Messages, reason: string) =>
  (
    ({
      incorrect: t.incorrect,
      did_not_follow_request: t.didNotFollowRequest,
      incomplete: t.incomplete,
      poor_tool_choice: t.poorToolChoice,
      too_slow: t.tooSlow,
      other: t.other,
    }) as Record<string, string>
  )[reason] ?? reason;

export const usageKindLabel = (t: Messages, kind: "chat" | "background" | "live-transcription") =>
  kind === "live-transcription" ? t.liveDictation : kind === "chat" ? t.chatRuns : t.backgroundAi;

export const usageRangeLabel = (t: Messages, range: AiUsageQuery["range"]) =>
  ({ "24h": t.range24h, "7d": t.range7d, "30d": t.range30d, "90d": t.range90d })[range];

/**
 * The usage explorer's filters as one list query, keeping the parameter names of `AiUsageQuerySchema` (`range`,
 * `userId`, …, `search`): the period always, the people and models of every view, rating and reason for Feedback,
 * kind, state, task and the error search for Runs. Names of the codes in the address come from the report
 * (`names`); a lookup searches the facets of the period shown.
 */
export const usageQuery = (
  locale: string,
  view: AiUsageQuery["view"],
  range: AiUsageQuery["range"],
  names: (field: Facet, id: string) => string,
) => {
  const t = aiUsageMessages.resolve([locale]).t;
  const lookup = (key: Facet, label: string) =>
    field.lookup({
      label,
      multiple: false,
      common: key === "userId" || key === "modelId",
      load: async (search, { signal, limit }) => {
        const response = await coreClient.admin.core["ai-usage"].facets.$get(
          { query: { field: key, search, range } },
          { init: { signal } },
        );
        if (!response.ok) throw new Error(t.filterLoadFailed);
        const data = await response.json();
        const items: LookupItem[] = data.items.map((item) => ({
          value: item.id,
          label:
            key === "userId"
              ? principalLabel({ principal: { type: "user", userId: item.id }, displayName: item.label ?? undefined }, locale)
              : (item.label ?? item.id),
        }));
        return {
          items: [...(key === "userId" && !search ? [{ value: "unassigned", label: t.unassigned }] : []), ...items].slice(0, limit),
        };
      },
      resolve: async (values) => values.map((value) => ({ value, label: names(key, value) })),
    });
  const base = {
    range: field.choice({
      label: t.range,
      options: AI_USAGE_RANGES.map((value) => ({ value, label: usageRangeLabel(t, value) })),
      multiple: false,
      required: "30d",
      common: true,
    }),
    userId: lookup("userId", t.user),
    modelId: lookup("modelId", t.model),
    providerModel: lookup("providerModel", t.providerModel),
    appId: lookup("appId", t.application),
  };
  const feedback = {
    rating: field.choice({
      label: t.rating,
      options: [
        { value: "up", label: t.helpful },
        { value: "down", label: t.needsWork },
      ],
      multiple: false,
      common: true,
    }),
    reason: field.choice({
      label: t.reason,
      options: AI_USAGE_REASONS.map((value) => ({ value, label: usageReasonLabel(t, value) })),
      multiple: false,
    }),
  };
  const runs = {
    kind: field.choice({
      label: t.runKind,
      options: (["chat", "background", "live-transcription"] as const).map((value) => ({ value, label: usageKindLabel(t, value) })),
      multiple: false,
      common: true,
    }),
    status: field.choice({
      label: t.status,
      options: [
        { value: "completed", label: t.completed },
        { value: "failed", label: t.failed },
        { value: "running", label: t.running },
      ],
      multiple: false,
      common: true,
    }),
    task: lookup("task", t.backgroundTask),
    errorCode: field.text({ label: t.errorCode }),
    search: field.text({ label: t.searchErrors }),
  };
  return defineListQuery({
    key: `core.ai.usage.${view}`,
    fields: { ...base, ...(view === "feedback" ? feedback : {}), ...(view === "runs" ? runs : {}) },
    sort: { fixed: { field: "default", direction: "desc", label: t.orderInTable } },
    pageParams: ["sec", "until", "direction", "page", "perPage", "workflowId", "workflowRunId", "compare", "run", "feedback"],
  });
};

export type UsageListQuery = ReturnType<typeof usageQuery>;
export type UsageListState = ListQueryStateOf<UsageListQuery>;

/** The report's query as the bar's state: only its filter parameters, read through the declaration. */
export const usageState = (query: UsageListQuery, current: AiUsageQuery): UsageListState =>
  query.parse(aiUsageSearchParams(Object.fromEntries(USAGE_FILTER_KEYS.map((key) => [key, current[key]])))).state;

/** The query the explorer loads for a state of the bar: its filters on top of the page's own parameters, page 1. */
export const usageFromState = (current: AiUsageQuery, state: UsageListState): AiUsageQuery => {
  const filters: Readonly<Record<string, unknown>> = state.filters;
  const own = Object.fromEntries(
    USAGE_FILTER_KEYS.map((key) => [key, typeof filters[key] === "string" && filters[key] !== "" ? filters[key] : undefined]),
  );
  return AiUsageQuerySchema.parse({ ...current, ...own, page: 1 });
};
