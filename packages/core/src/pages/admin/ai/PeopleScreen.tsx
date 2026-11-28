import { coreClient } from "@k2b/cloud/clients/core";
import { type AiQuotaBalance, type AiQuotaReportQuery, type AiQuotaReportRow, aiQuotaHref, formatDateTime } from "@k2b/cloud/shared";
import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import {
  Avatar,
  Bar,
  Button,
  Canvas,
  Cells,
  Chip,
  Dialog,
  Disclosure,
  Empty,
  Facts,
  FilterBar,
  Inline,
  Input,
  type NavProps,
  Notice,
  Pane,
  Path,
  Progress,
  Section,
  Table,
  Text,
  useLocale,
  useToast,
} from "@k2b/ui/v2";
import { createMemo, createSignal, For, Show } from "solid-js";
import StateWord from "../_area/StateWord";
import { quotaMessages } from "../settings/_components/ai-quota-messages";
import { AI_COLOR, aiAreaLink, aiSectionLabel } from "./frame";
import { BarChart, hasPoints, TimeChart } from "./insight-chart";
import type { AiPeopleData } from "./insight-data";
import { PageBar } from "./insight-parts";
import { type PeopleListState, peopleHref, peopleQuery, peopleState, quotaRangeLabel, quotaStatusLabel } from "./people-query";

const api = coreClient.admin.core["ai-quotas"];
const STEP = { "24h": 3_600_000, "7d": 86_400_000, "30d": 86_400_000, "90d": 86_400_000 } as const;

/**
 * Budgets › Nutzung je Person on v2: the period's figures and its reference costs over time, then who used how much
 * against which allowance, with search, filters, sort and pages in the address, and the person the address names
 * (`identity`) beside the list with their allowances and the reset of each one.
 */
export default function PeopleScreen(props: { nav: NavProps; data: AiPeopleData }) {
  const locale = useLocale();
  const t = () => quotaMessages.resolve([locale()]).t;
  const toast = useToast();
  const report = () => props.data.report;
  const q = () => report().query;
  const unit = () => props.data.config.unit ?? "EUR";
  const n = (value: number) => value.toLocaleString(locale(), { maximumFractionDigits: 6 });
  const amount = (value: number | null) => (value === null ? "—" : value.toLocaleString(locale(), { maximumSignificantDigits: 6 }));
  const date = (value: string) => formatDateTime(value, { locale: locale(), timeZone: props.data.timeZone });
  const modelName = (id: string) => (id === "*" ? t().all : (props.data.models.find((model) => model.id === id)?.label ?? id));
  const href = (patch: Partial<AiQuotaReportQuery>) => aiQuotaHref({ ...q(), ...patch });

  const query = createMemo(() => peopleQuery(locale(), props.data.models));
  const state = createMemo(() => peopleState(query(), q()));
  const change = (next: PeopleListState) => {
    const target = peopleHref(q(), next);
    if (target !== href({ page: 1, identity: undefined })) window.location.replace(target);
  };
  const search = (value: string) => window.location.assign(href({ search: value.trim(), page: 1, identity: undefined }));

  const selected = () => (q().identity ? report().selected : null);
  const closed = () => href({ identity: undefined });
  const sorted = (column: "label" | "cost" | "lastUsed") => ({
    href: href({ sort: column, direction: q().sort === column && q().direction === "desc" ? "asc" : "desc", page: 1 }),
  });
  const sortColumn = () => ({ label: 0, cost: 1, lastUsed: 3 })[q().sort];

  /** The state of an account: quiet when its allowances are fine, toned when one is used up or not measurable. */
  const RowState = (stateProps: { row: AiQuotaReportRow }) => (
    <Show
      when={stateProps.row.status === "exhausted" || stateProps.row.status === "unknown"}
      fallback={<StateWord muted={stateProps.row.status === "disabled"}>{quotaStatusLabel(t(), stateProps.row.status)}</StateWord>}
    >
      <Chip status={stateProps.row.status === "exhausted" ? "bad" : "warn"}>{quotaStatusLabel(t(), stateProps.row.status)}</Chip>
    </Show>
  );
  /** The tightest allowance of an account as a bar ("12 / 30 EUR"); unlimited and unmeasured ones say so in words. */
  const tightest = (row: AiQuotaReportRow) =>
    row.balances
      .filter((balance) => balance.limit !== null && !balance.bypassed)
      .toSorted((a, b) => b.used / Math.max(b.limit ?? 1, 0.000001) - a.used / Math.max(a.limit ?? 1, 0.000001))[0];
  const Allowance = (allowanceProps: { row: AiQuotaReportRow }) => {
    const balance = () => tightest(allowanceProps.row);
    return (
      <Show when={balance()} fallback={<RowState row={allowanceProps.row} />}>
        {(shown) => (
          <Progress
            value={shown().used}
            of={Math.max(shown().limit ?? 0, 0.000001)}
            label={`${modelName(shown().scope)} · ${amount(shown().used)} / ${amount(shown().limit)} ${unit()}${
              allowanceProps.row.balances.length > 1 ? ` · +${allowanceProps.row.balances.length - 1}` : ""
            }`}
          />
        )}
      </Show>
    );
  };

  const costSeries = () => [
    { label: t().cost, points: report().timeline.map((point) => ({ at: Date.parse(point.at), value: point.cost })) },
  ];
  const byModel = () =>
    report()
      .models.filter((model) => model.cost !== null)
      .map((model) => ({ label: modelName(model.model), value: model.cost ?? 0 }));
  const axis = (at: number) =>
    new Date(at).toLocaleString(locale(), {
      timeZone: props.data.timeZone,
      ...(q().range === "24h" ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric" }),
    });

  // The open person's allowances, read by the server; a reset asks first and then shows the new state.
  const [busy, setBusy] = createSignal<string | null>(null);
  const [failure, setFailure] = createSignal<string | null>(null);
  const reset = async (balance: AiQuotaBalance) => {
    const who = selected();
    if (!who || busy()) return;
    const scope = modelName(balance.scope);
    if (!(await Dialog.confirm({ title: `${t().reset}: ${scope}`, description: `${who.label} · ${t().resetConfirm}`, confirm: t().reset })))
      return;
    setBusy(balance.scope);
    setFailure(null);
    try {
      const response = await api.reset.$post({
        json: { type: who.type, id: who.id, scope: balance.scope, requestId: crypto.randomUUID() },
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const message = body && typeof body === "object" && "message" in body ? body.message : undefined;
        throw new Error(typeof message === "string" ? message : t().error);
      }
      toast(t().resetDone, { status: "ok" });
      window.location.reload();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t().error);
      setBusy(null);
    }
  };

  const balanceFacts = (balance: AiQuotaBalance) => [
    {
      label: t().used,
      value:
        balance.limit === null || balance.bypassed ? (
          `${amount(balance.used)} ${unit()} · ${balance.bypassed ? t().bypassed : t().unlimited}`
        ) : (
          <Progress
            value={balance.used}
            of={Math.max(balance.limit, 0.000001)}
            label={`${amount(balance.used)} / ${amount(balance.limit)} ${unit()}`}
          />
        ),
    },
    { label: t().input, value: n(balance.input) },
    { label: t().output, value: n(balance.output) },
    { label: t().until, value: date(balance.resetsAt) },
    {
      label: t().source,
      value: balance.sourceDetails?.length
        ? balance.sourceDetails.map((source) => (source.principal.type === "authenticated" ? t().allUsers : source.displayName)).join(", ")
        : balance.sources.join(", ") || t().missing,
    },
    ...(balance.estimated ? [{ label: t().estimated, value: n(balance.estimated) }] : []),
  ];

  return (
    <AdminWorkspace
      nav={props.nav}
      // a detail column only while a person is open: no empty half (identity rule 5)
      detail={selected() ? 420 : undefined}
      head={
        <Bar
          start={
            <Path
              label={aiAreaLink(locale()).label}
              items={[
                aiAreaLink(locale()),
                { label: aiSectionLabel(locale(), "budgets"), href: "/admin/ai?sec=budgets" },
                { label: t().perPerson },
              ]}
            />
          }
          end={
            <>
              <Input
                type="search"
                icon="search"
                label={t().search}
                placeholder={t().searchShort}
                value={q().search}
                onKeyDown={(event) => {
                  if (event.isComposing) return;
                  const input = event.currentTarget as HTMLInputElement;
                  if (event.key === "Enter") search(input.value);
                  if (event.key === "Escape" && input.value) search("");
                }}
              />
              {/* slot for #4208/#4223 (DP): FilterBar end, where this refresh stands at the end of the filter row; until then it stands in the head */}
              <Button variant="ghost" icon="refresh" href={href({ until: undefined })}>
                {t().refresh}
              </Button>
            </>
          }
        />
      }
    >
      <Pane.Split>
        <Pane
          label={t().perPerson}
          scrollKey="admin-ai-people"
          width={selected() ? { min: 480, default: 720 } : undefined}
          status={
            <FilterBar
              query={query()}
              state={state()}
              onChange={change}
              timeZone={props.data.timeZone}
              results={t().accountsCount({ count: n(report().total) })}
            />
          }
        >
          {/* k2b-ui gap: Hero figure (#4360); the strip of key figures leads until the figure type 30 exists. */}
          <Cells>
            <Cells.Cell
              icon="receipt"
              color={AI_COLOR}
              label={`${t().costShort} (${unit()})`}
              value={amount(report().overview.cost)}
              meta={quotaRangeLabel(t(), q().range)}
              // slot for #4208/#4223 (DP): Cells trend, the cost per step (report().timeline cost) as a spark with t().costTrend
            />
            <Cells.Cell
              icon="users"
              label={t().active}
              value={n(report().overview.accounts)}
              meta={props.data.config.enabled ? t().limitsOn : t().disabled}
            />
            <Cells.Cell
              icon="coins"
              label={t().output}
              value={report().overview.calls && !report().overview.measured ? "—" : n(report().overview.output)}
              meta={t().tokens}
            />
            <Cells.Cell
              icon="ruler-measure"
              label={t().recordedCalls}
              value={`${n(report().overview.measured)} / ${n(report().overview.calls)}`}
              meta={`${n(report().overview.unknown)} ${t().unknown} · ${n(report().overview.estimated)} ${t().estimates}`}
            />
          </Cells>
          <Show when={!props.data.config.enabled}>
            <Notice tone="note" icon="gauge-off" actions={[{ label: t().openRules, href: "/admin/ai?sec=budgets" }]}>
              {t().disabledHint}
            </Notice>
          </Show>
          <Section icon="chart-line" color={AI_COLOR} title={t().timeline} count={unit()} summary={t().chartHint}>
            <Canvas label={t().timeline} height={140}>
              <Show when={hasPoints(costSeries())} fallback={<Empty icon="chart-line" text={t().noUsage} />}>
                <TimeChart series={costSeries()} step={STEP[q().range]} format={(value) => amount(value)} axis={axis} />
              </Show>
            </Canvas>
          </Section>
          <Section icon="users" title={t().users} count={n(report().total)}>
            <Table
              label={t().users}
              rows={report().items}
              rowKey={(row) => `${row.type}:${row.id}`}
              current={selected() ? `${selected()!.type}:${selected()!.id}` : undefined}
              sort={{ column: sortColumn(), direction: q().direction === "asc" ? "ascending" : "descending" }}
              open={(row) => ({ href: href({ identity: row.id, identityType: row.type }) })}
              empty={{ icon: "user-search", text: `${t().noResults}. ${t().noResultsHint}` }}
              phone={(row) => ({
                avatar: { name: row.label },
                lines: [row.label, `${amount(row.cost)} ${unit()} · ${quotaStatusLabel(t(), row.status)}`],
                time: row.lastUsed ? date(row.lastUsed) : undefined,
              })}
              columns={[
                {
                  title: t().account,
                  width: { min: 180, default: 240 },
                  // slot for #4208/#4223 (DP): Column avatar of the account (it replaces the Avatar in the cell)
                  sort: sorted("label"),
                  cell: (row) => (
                    <Inline>
                      <Avatar name={row.label} decorative />
                      {row.label}
                    </Inline>
                  ),
                },
                {
                  title: t().costShort,
                  width: { min: 100, default: 120 },
                  align: "end",
                  sort: sorted("cost"),
                  cell: (row) => amount(row.cost),
                },
                { title: t().current, width: { min: 240, default: 300 }, drop: true, cell: (row) => <Allowance row={row} /> },
                {
                  title: t().lastUsed,
                  width: { min: 130, default: 150 },
                  drop: true,
                  sort: sorted("lastUsed"),
                  cell: (row) => (row.lastUsed ? date(row.lastUsed) : "—"),
                },
                { title: t().tokens, drop: true, align: "end", cell: (row) => `${n(row.input)} / ${n(row.output)}` },
              ]}
            />
            <PageBar page={report().page} perPage={report().perPage} total={report().total} href={(page) => href({ page })} />
          </Section>
          <Show when={byModel().length > 1}>
            <Section icon="chart-bar" title={t().byModel} summary={t().modelChartHint}>
              <Canvas label={t().byModel} height={180}>
                <BarChart data={byModel()} format={(value) => amount(value)} />
              </Canvas>
            </Section>
          </Show>
          <Disclosure title={t().tokenTitle}>
            <Text muted>{`${t().tokenHint} ${t().periodHint}`}</Text>
          </Disclosure>
        </Pane>
        <Show when={selected()}>
          {(who) => (
            <Pane
              detail
              label={who().label}
              back={{ label: t().users, href: closed() }}
              head={
                <Bar
                  start={
                    // k2b-ui gap: tinted object head (ObjectHead, #4360)
                    <Inline>
                      <Avatar name={who().label} decorative />
                      <Text type="body">{who().label}</Text>
                    </Inline>
                  }
                  end={
                    <>
                      <Show when={who().type === "user"}>
                        <Button
                          variant="text"
                          icon="chart-histogram"
                          href={`/admin/ai?sec=usage&view=comparisons&userId=${who().id}&range=${q().range}`}
                        >
                          {t().historyLink}
                        </Button>
                      </Show>
                      <Button variant="ghost" icon="x" label={t().close} href={closed()} />
                    </>
                  }
                />
              }
            >
              <Show when={failure()}>
                {(message) => (
                  <Notice tone="bad" title={t().error}>
                    {message()}
                  </Notice>
                )}
              </Show>
              <Show
                when={props.data.balance}
                fallback={
                  <Notice tone="bad" title={t().error} primary={{ label: t().reload, onClick: () => window.location.reload() }}>
                    {t().balanceFailed}
                  </Notice>
                }
              >
                {(snapshot) => (
                  <>
                    <Show when={!snapshot().enabled}>
                      <Notice tone="note" icon="gauge-off">
                        {t().disabledHint}
                      </Notice>
                    </Show>
                    <Show when={snapshot().balances.length} fallback={<Empty icon="gauge" text={t().noRules} />}>
                      <For each={snapshot().balances}>
                        {(balance) => (
                          <Section
                            icon="gauge"
                            title={modelName(balance.scope)}
                            actions={[
                              {
                                label: t().reset,
                                icon: "refresh",
                                disabled: busy() !== null,
                                onClick: () => void reset(balance),
                              },
                            ]}
                          >
                            <Show when={balance.unknown}>
                              <Notice tone="warn" title={t().unknownStatus}>
                                {`${t().unknown}: ${n(balance.unknown)}. ${t().unknownHint}`}
                              </Notice>
                            </Show>
                            <Facts items={balanceFacts(balance)} />
                          </Section>
                        )}
                      </For>
                    </Show>
                  </>
                )}
              </Show>
            </Pane>
          )}
        </Show>
      </Pane.Split>
    </AdminWorkspace>
  );
}
