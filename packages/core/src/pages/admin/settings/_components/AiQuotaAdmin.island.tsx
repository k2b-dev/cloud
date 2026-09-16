import { navigateTo } from "@k2b/ssr/nav";
import {
  Button,
  ButtonLink,
  DataTable,
  NoticeCard,
  LocaleProvider,
  dialogCore,
  panelDialogOptions,
  FilterChip,
  Pagination,
  Placeholder,
  ProgressBar,
  Select,
  StatCell,
  StatGrid,
  TextInput,
  Tabs,
  useLocale,
} from "@k2b/ui";
import { coreClient } from "@k2b/cloud/clients/core";
import {
  aiQuotaHref,
  AiQuotaReportQuerySchema,
  type AiQuotaConfig,
  type AiQuotaReport,
  type AiQuotaReportQuery,
  type AiQuotaIdentity as Identity,
  type AiQuotaStatus,
} from "@k2b/cloud/shared";
import { createSignal, For, Show } from "solid-js";
import { quotaMessages } from "./ai-quota-messages";
import AiQuotaIdentity from "./AiQuotaIdentity";
import AiQuotaDetail from "./AiQuotaDetail";
import AiQuotaRules from "./AiQuotaRules";
import AiQuotaCharts from "./AiQuotaCharts";
const api = coreClient.admin.core["ai-quotas"];
export default function AiQuotaAdmin(props: {
  config: AiQuotaConfig;
  models: {
    id: string;
    label: string;
    enabled: boolean;
    capabilities: string[];
    pricing?: { inputPerMillion: number; outputPerMillion: number };
  }[];
  report: AiQuotaReport;
}) {
  const locale = useLocale(),
    t = () => quotaMessages.resolve([locale()]).t;
  const q = () => props.report.query;
  const [search, setSearch] = createSignal(q().search);
  const n = (v: number) => v.toLocaleString(locale(), { maximumFractionDigits: 6 });
  const name = (id: string) => (id === "*" ? t().all : (props.models.find((m) => m.id === id)?.label ?? id));
  const amount = (v: number) => v.toLocaleString(locale(), { maximumSignificantDigits: 6 });
  const status = (s: AiQuotaStatus) =>
    ({ disabled: t().disabled, available: t().available, unlimited: t().unlimited, exhausted: t().exhausted, unknown: t().unknownStatus })[
      s
    ];
  const statusClass = (s: AiQuotaStatus) => (s === "unknown" || s === "exhausted" ? "text-amber-600 dark:text-amber-400" : "text-dimmed");
  const href = (patch: Partial<AiQuotaReportQuery>) => aiQuotaHref({ ...q(), ...patch });
  const change = (patch: Partial<AiQuotaReportQuery>) => navigateTo(href({ ...patch, page: 1, identity: undefined }));
  function openDetail(who: Identity) {
    let changed = false;
    void dialogCore
      .open<void>((close, context) => {
        const [saving, setSaving] = createSignal(false);
        const requestClose = () => {
          if (!saving()) close();
        };
        context.setDismissHandler(requestClose);
        return (
          <LocaleProvider locale={locale()}>
            <AiQuotaDetail
              unit={props.config.unit ?? "EUR"}
              who={who}
              modelName={name}
              range={q().range}
              close={requestClose}
              saving={setSaving}
              changed={() => {
                changed = true;
              }}
            />
          </LocaleProvider>
        );
      }, panelDialogOptions)
      .then(() => {
        if (changed) void navigateTo(href({ until: undefined, identity: undefined }));
      });
  }
  return (
    <div class="app-rows min-w-0 p-3">
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 class="text-base font-semibold text-primary">{t().title}</h1>
          <p class="mt-1 text-xs text-dimmed">{t().description}</p>
        </div>
        <Show when={q().view === "users"}>
          <span class="text-xs text-dimmed">{props.config.enabled ? t().enabled : t().disabled}</span>
        </Show>
      </div>
      <NoticeCard tone="info" title={t().tokenTitle} detail={t().tokenHint} />
      <Tabs
        ariaLabel={t().title}
        value={q().view}
        onValueChange={(view) => void navigateTo(href({ view, identity: undefined }))}
        options={(["users", "rules"] as const).map((value) => ({ value, label: t()[value] }))}
      />
      <Show
        when={q().view === "rules"}
        fallback={
          <>
            <Show when={!props.config.enabled}>
              <p class="text-xs text-dimmed">{t().disabledHint}</p>
            </Show>
            <div class="flex flex-wrap items-center gap-2">
              <form
                role="search"
                class="w-full sm:w-64"
                onSubmit={(e) => {
                  e.preventDefault();
                  void change({ search: search() });
                }}
              >
                <TextInput
                  type="search"
                  icon="ti ti-search"
                  aria-label={t().search}
                  placeholder={t().search}
                  value={search()}
                  onValueChange={setSearch}
                />
              </form>
              <FilterChip
                label={`${t().period}: ${q().range}`}
                icon="ti ti-clock"
                value={[q().range]}
                options={[{ options: ["24h", "7d", "30d", "90d"].map((value) => ({ value, label: value })) }]}
                onValueChange={(values) => void change({ range: AiQuotaReportQuerySchema.shape.range.parse(values[0]) })}
              />
              <Select
                aria-label={t().scope}
                placeholder={t().all}
                class="w-48"
                value={q().model || null}
                clearable
                searchable
                options={props.models.map((m) => ({ value: m.id, label: m.label }))}
                onValueChange={(model) => void change({ model: model ?? "" })}
              />
              <FilterChip
                label={t().status}
                icon="ti ti-adjustments"
                value={[q().status]}
                isActive={q().status !== "all"}
                options={[
                  {
                    options: [
                      { value: "all", label: t().allStatuses },
                      ...(["disabled", "available", "unlimited", "exhausted", "unknown"] as const).map((value) => ({
                        value,
                        label: status(value),
                      })),
                    ],
                  },
                ]}
                onValueChange={(values) => void change({ status: AiQuotaReportQuerySchema.shape.status.parse(values[0]) })}
              />
              <ButtonLink size="sm" variant="ghost" href={aiQuotaHref({})}>
                {t().resetFilters}
              </ButtonLink>
              <ButtonLink size="sm" variant="secondary" href={href({ until: undefined })}>
                {t().refresh}
              </ButtonLink>
            </div>
            <p class="text-xs text-dimmed">{t().periodHint}</p>
            <StatGrid columns={4}>
              <StatCell label={t().active} value={n(props.report.overview.accounts)} sub={q().range} />
              <StatCell
                label={t().cost}
                value={
                  props.report.overview.cost === null
                    ? "—"
                    : props.report.overview.cost.toLocaleString(locale(), { maximumSignificantDigits: 6 })
                }
                sub={props.config.unit ?? "EUR"}
              />
              <StatCell
                label={t().output}
                value={props.report.overview.calls && !props.report.overview.measured ? "—" : n(props.report.overview.output)}
                sub={t().tokens}
              />
              <StatCell
                label={t().recordedCalls}
                value={`${n(props.report.overview.measured)} / ${n(props.report.overview.calls)}`}
                sub={`${n(props.report.overview.unknown)} ${t().unknown} · ${n(props.report.overview.estimated)} ${t().estimates}`}
              />
            </StatGrid>
            <Show when={props.report.overview.calls > 0}>
              <AiQuotaCharts report={props.report} modelName={name} />
            </Show>
            <div class="min-w-0">
              <DataTable.Panel class="self-start">
                <DataTable.Header title={t().users} subtitle={`${props.report.total} · ${t().current}`} />
                <DataTable
                  rows={props.report.items}
                  getRowId={(r) => `${r.type}:${r.id}`}
                  density="compact"
                  surface="plain"
                  sort={{ key: q().sort, direction: q().direction }}
                  sortHref={(sort) =>
                    href({ sort: AiQuotaReportQuerySchema.shape.sort.parse(sort.key), direction: sort.direction, page: 1 })
                  }
                  columns={[
                    { id: "label", header: t().account, sortable: true },
                    { id: "cost", header: t().cost, align: "right", sortable: true },
                    { id: "balances", header: t().current },
                    { id: "lastUsed", header: t().lastUsed, sortable: true },
                    { id: "details", header: t().details, align: "right" },
                  ]}
                  empty={<Placeholder variant="compact" title={t().noResults} description={t().noResultsHint} />}
                  renderCell={({ row, col }) => {
                    if (col.id === "label") return <AiQuotaIdentity type={row.type} label={row.label} />;
                    if (col.id === "cost" && row.cost === null) return "—";
                    if (col.id === "cost")
                      return (
                        <span class="tabular-nums">
                          {row.cost === null ? "—" : amount(row.cost)} {props.config.unit ?? "EUR"}
                          <span class="block text-xs text-dimmed">
                            {n(row.input)} / {n(row.output)}
                          </span>
                        </span>
                      );
                    if (col.id === "balances")
                      return (
                        <div class="flex min-w-48 flex-col gap-3 py-2">
                          <For each={row.balances} fallback={<span class={statusClass(row.status)}>{status(row.status)}</span>}>
                            {(b) => (
                              <div class="flex flex-col gap-1">
                                <div class="flex justify-between gap-4 text-xs">
                                  <span>{name(b.scope)}</span>
                                  <span class="tabular-nums text-dimmed">
                                    {amount(b.used)} / {b.limit === null ? t().unlimited : amount(b.limit)} {props.config.unit ?? "EUR"}
                                  </span>
                                </div>
                                <Show when={b.limit !== null && !b.bypassed}>
                                  <ProgressBar
                                    tone={b.limit !== null && b.used >= b.limit ? "danger" : "info"}
                                    size="xs"
                                    label={`${name(b.scope)} ${t().used}`}
                                    value={b.limit === 0 ? 100 : (b.used / (b.limit ?? 1)) * 100}
                                  />
                                </Show>
                                <Show when={b.bypassed || b.unknown}>
                                  <span class="text-xs text-dimmed">{b.bypassed ? t().bypassed : t().unknownStatus}</span>
                                </Show>
                              </div>
                            )}
                          </For>
                        </div>
                      );
                    if (col.id === "details")
                      return (
                        <Button variant="ghost" size="sm" aria-label={`${t().details}: ${row.label}`} onClick={() => openDetail(row)}>
                          <i class="ti ti-eye" aria-hidden="true" />
                        </Button>
                      );
                    return <span class="text-xs text-dimmed">{row.lastUsed ? new Date(row.lastUsed).toLocaleString(locale()) : "—"}</span>;
                  }}
                />
                <DataTable.Footer>
                  <Pagination
                    currentPage={props.report.page}
                    totalPages={Math.ceil(props.report.total / props.report.perPage)}
                    baseUrl={`${href({ page: undefined })}&page=`}
                  />
                </DataTable.Footer>
              </DataTable.Panel>
            </div>
          </>
        }
      >
        <AiQuotaRules config={props.config} models={props.models} />
      </Show>
    </div>
  );
}
