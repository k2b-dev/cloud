import { type AiQuotaReportQuery, AiQuotaReportQuerySchema, type AiQuotaStatus, aiQuotaHref } from "@k2b/cloud/shared";
import { defineListQuery, field, type ListQueryStateOf } from "@k2b/ui/v2/list-query";
import { quotaMessages } from "../settings/_components/ai-quota-messages";

type Messages = ReturnType<typeof quotaMessages.resolve>["t"];

export const QUOTA_STATUSES = ["available", "exhausted", "unknown", "unlimited", "disabled"] as const satisfies readonly AiQuotaStatus[];

export const quotaStatusLabel = (t: Messages, status: AiQuotaStatus) =>
  ({ disabled: t.disabled, available: t.available, unlimited: t.unlimited, exhausted: t.exhausted, unknown: t.unknownStatus })[status];

const RANGES = ["24h", "7d", "30d", "90d"] as const;
export const quotaRangeLabel = (t: Messages, range: AiQuotaReportQuery["range"]) =>
  ({ "24h": t.range24h, "7d": t.range7d, "30d": t.range30d, "90d": t.range90d })[range];

/**
 * The people report's filters as one list query with the parameter names of `AiQuotaReportQuerySchema`: the period
 * always, a model scope and an allowance state when chosen. Search, sort, page and the open person the page keeps.
 */
export const peopleQuery = (locale: string, models: readonly { id: string; label: string }[]) => {
  const t = quotaMessages.resolve([locale]).t;
  return defineListQuery({
    key: "core.ai.budgets.people",
    fields: {
      range: field.choice({
        label: t.period,
        options: RANGES.map((value) => ({ value, label: quotaRangeLabel(t, value) })),
        multiple: false,
        required: "30d",
        common: true,
      }),
      model: field.choice({
        label: t.scope,
        options: models.map((model) => ({ value: model.id, label: model.label })),
        multiple: false,
        common: true,
      }),
      status: field.choice({
        label: t.status,
        options: QUOTA_STATUSES.map((value) => ({ value, label: quotaStatusLabel(t, value) })),
        multiple: false,
        common: true,
      }),
    },
    sort: { fixed: { field: "default", direction: "desc", label: t.orderInTable } },
    pageParams: ["sec", "rule", "search", "direction", "page", "until", "identity", "identityType"],
  });
};

export type PeopleListQuery = ReturnType<typeof peopleQuery>;
export type PeopleListState = ListQueryStateOf<PeopleListQuery>;

/** The report's query as the bar's state. */
export const peopleState = (query: PeopleListQuery, current: AiQuotaReportQuery): PeopleListState => {
  const params = new URLSearchParams();
  if (current.range !== "30d") params.set("range", current.range);
  if (current.model) params.set("model", current.model);
  if (current.status !== "all") params.set("status", current.status);
  return query.parse(params).state;
};

/** The address of the report for a state of the bar: page 1, no person open, search and sort kept. */
export const peopleHref = (current: AiQuotaReportQuery, state: PeopleListState) => {
  const filters: Readonly<Record<string, unknown>> = state.filters;
  const text = (key: string) => (typeof filters[key] === "string" ? String(filters[key]) : undefined);
  const next = AiQuotaReportQuerySchema.parse({
    ...current,
    range: text("range") ?? "30d",
    model: text("model") ?? "",
    status: text("status") ?? "all",
    page: 1,
    identity: undefined,
  });
  return aiQuotaHref(next);
};
