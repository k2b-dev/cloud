import { query } from "@k2b/stdlib/solid";
import { navigateTo } from "@k2b/ssr/nav";
import {
  Button,
  ButtonLink,
  DataTable,
  DetailPanel,
  FilterChip,
  Pagination,
  Placeholder,
  ProgressBar,
  Select,
  StatCell,
  StatGrid,
  TextInput,
  Tabs,
  prompts,
  useLocale,
} from "@k2b/ui";
import { coreClient } from "@k2b/cloud/clients/core";
import {
  aiQuotaHref,
  AiQuotaReportQuerySchema,
  type AiQuotaConfig,
  type AiQuotaReport,
  type AiQuotaReportQuery,
  type AiQuotaSnapshot,
  type AiQuotaStatus,
} from "@k2b/cloud/shared";
import { createSignal, For, Show } from "solid-js";
import { quotaMessages } from "./ai-quota-messages";
import AiQuotaRules from "./AiQuotaRules";
import AiQuotaCharts from "./AiQuotaCharts";
const api = coreClient.admin.core["ai-quotas"];
export default function AiQuotaAdmin(props: {
  config: AiQuotaConfig;
  models: { id: string; label: string }[];
  report: AiQuotaReport;
  balance: AiQuotaSnapshot | null;
}) {
  const locale = useLocale(),
    t = () => quotaMessages.resolve([locale()]).t;
  const q = () => props.report.query;
  const [search, setSearch] = createSignal(q().search);
  const [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal("");
  const n = (v: number) => v.toLocaleString(locale());
  const name = (id: string) => (id === "*" ? t().all : (props.models.find((m) => m.id === id)?.label ?? id));
  const status = (s: AiQuotaStatus) =>
    ({ disabled: t().disabled, available: t().available, unlimited: t().unlimited, exhausted: t().exhausted, unknown: t().unknownStatus })[
      s
    ];
  const statusClass = (s: AiQuotaStatus) => (s === "unknown" || s === "exhausted" ? "text-amber-600 dark:text-amber-400" : "text-dimmed");
  const href = (patch: Partial<AiQuotaReportQuery>) => aiQuotaHref({ ...q(), ...patch });
  const change = (patch: Partial<AiQuotaReportQuery>) => navigateTo(href({ ...patch, page: 1, identity: undefined }));
  const selected = () => props.report.selected;
  const identityKey = () => (q().identity ? `${q().identityType}:${q().identity}` : "");
  const balance = query.create({
    source: identityKey,
    initial: { source: identityKey(), data: { key: identityKey(), snapshot: props.balance } },
    load: async (key, { abortSignal }) => {
      if (!q().identity) return { key, snapshot: null };
      const response = await api.balance.$get({ query: { type: q().identityType, id: q().identity! } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(t().error);
      return { key, snapshot: await response.json() };
    },
  });
  const shownBalance = () => (balance.data()?.key === identityKey() ? balance.data()?.snapshot : null);
  async function reset(scope: string) {
    if (busy() || !selected() || !shownBalance()) return;
    const who = selected()!;
    if (!(await prompts.confirm(`${who.label} · ${name(scope)}\n\n${t().resetConfirm}`))) return;
    setBusy(true);
    setError("");
    try {
      const response = await api.reset.$post({ json: { type: who.type, id: who.id, scope, requestId: crypto.randomUUID() } });
      if (!response.ok) {
        const body = await response.json();
        throw new Error("message" in body ? body.message : t().error);
      }
      await navigateTo(href({ until: undefined }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
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
                label={t().input}
                value={props.report.overview.calls && !props.report.overview.measured ? "—" : n(props.report.overview.input)}
                sub={t().tokens}
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
            <div class={`grid min-w-0 gap-3 ${selected() ? "xl:grid-cols-[minmax(0,3fr)_minmax(20rem,2fr)]" : ""}`}>
              <DataTable.Panel class="self-start">
                <DataTable.Header title={t().users} subtitle={`${props.report.total} · ${t().current}`} />
                <DataTable
                  rows={props.report.items}
                  getRowId={(r) => `${r.type}:${r.id}`}
                  selectedRowId={identityKey()}
                  density="compact"
                  surface="plain"
                  sort={{ key: q().sort, direction: q().direction }}
                  sortHref={(sort) =>
                    href({ sort: AiQuotaReportQuerySchema.shape.sort.parse(sort.key), direction: sort.direction, page: 1 })
                  }
                  columns={[
                    { id: "label", header: t().account, sortable: true },
                    { id: "tokens", header: t().tokens, align: "right", sortable: true },
                    { id: "status", header: t().status },
                    { id: "lastUsed", header: t().lastUsed, sortable: true },
                  ]}
                  empty={<Placeholder variant="compact" title={t().noResults} description={t().noResultsHint} />}
                  renderCell={({ row, col }) => {
                    if (col.id === "label")
                      return (
                        <a class="font-medium text-primary" href={href({ identity: row.id, identityType: row.type })}>
                          {row.label}
                          <Show when={row.type === "service_account"}>
                            <span class="block text-xs text-dimmed">Service account</span>
                          </Show>
                        </a>
                      );
                    if (col.id === "tokens" && row.calls && !row.measured) return "—";
                    if (col.id === "tokens")
                      return (
                        <span class="tabular-nums">
                          {n(row.input + row.output)}
                          <span class="block text-xs text-dimmed">
                            {n(row.input)} / {n(row.output)}
                          </span>
                        </span>
                      );
                    if (col.id === "status")
                      return (
                        <span class={statusClass(row.status)}>
                          {status(row.status)}
                          <Show when={row.scopes > 1}>
                            <span class="block text-xs">
                              {row.scopes} {t().limitedScopes} · {row.exhausted} {t().blockedScopes}
                            </span>
                          </Show>
                        </span>
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
              <Show when={selected()}>
                {(who) => (
                  <aside class="paper min-w-0 p-3" aria-label={who().label}>
                    <DetailPanel>
                      <DetailPanel.Header
                        title={who().label}
                        subtitle={t().current}
                        actions={
                          <ButtonLink size="sm" variant="ghost" href={href({ identity: undefined })}>
                            {t().close}
                          </ButtonLink>
                        }
                      />
                      <DetailPanel.Body>
                        <Show when={error()}>
                          <Placeholder state="error" description={error()} />
                        </Show>
                        <Show when={balance.loading()}>
                          <Placeholder state="loading" />
                        </Show>
                        <Show when={balance.error()}>
                          <Placeholder
                            state="error"
                            description={t().error}
                            action={<Button onClick={() => balance.refresh()}>{t().refresh}</Button>}
                          />
                        </Show>
                        <Show when={shownBalance() && !shownBalance()!.balances.length}>
                          <p class="text-sm text-dimmed">{t().noRules}</p>
                        </Show>
                        <For each={shownBalance()?.balances}>
                          {(b) => (
                            <DetailPanel.Section title={name(b.scope)}>
                              <p class="text-sm tabular-nums">
                                {n(b.used)} / {b.limit === null ? t().unlimited : n(b.limit)} {t().tokens}
                              </p>
                              <Show when={b.limit !== null && !b.bypassed}>
                                <ProgressBar
                                  size="xs"
                                  label={`${name(b.scope)} ${t().used}`}
                                  value={b.limit === 0 ? 100 : (b.used / (b.limit ?? 1)) * 100}
                                />
                              </Show>
                              <p class="text-xs text-dimmed">
                                {t().input}: {n(b.input)} · {t().output}: {n(b.output)}
                              </p>
                              <p class="text-xs text-dimmed">
                                {t().source}: {b.sources.join(", ") || t().missing}
                              </p>
                              <Show when={b.bypassed}>
                                <p class="text-xs text-dimmed">{t().bypassed}</p>
                              </Show>
                              <Show when={b.estimated}>
                                <p class="text-xs text-dimmed">
                                  {t().estimated}: {n(b.estimated ?? 0)}
                                </p>
                              </Show>
                              <Show when={b.unknown}>
                                <p class="text-xs text-amber-600">
                                  {t().unknown}: {n(b.unknown)}. {t().unknownHint}
                                </p>
                              </Show>
                              <p class="text-xs text-dimmed">
                                {t().until}: {new Date(b.resetsAt).toLocaleString(locale())}
                              </p>
                              <Button variant="secondary" size="sm" disabled={busy()} onClick={() => void reset(b.scope)}>
                                {t().reset}
                              </Button>
                            </DetailPanel.Section>
                          )}
                        </For>
                        <Show when={who().type === "user"}>
                          <ButtonLink
                            variant="ghost"
                            size="sm"
                            href={`/admin/settings?tab=ai-usage&view=comparisons&userId=${who().id}&range=${q().range}`}
                          >
                            {t().historyLink}
                          </ButtonLink>
                        </Show>
                      </DetailPanel.Body>
                    </DetailPanel>
                  </aside>
                )}
              </Show>
            </div>
          </>
        }
      >
        <AiQuotaRules config={props.config} models={props.models} />
      </Show>
    </div>
  );
}
