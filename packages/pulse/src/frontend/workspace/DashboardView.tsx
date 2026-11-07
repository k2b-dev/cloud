import { navigateTo } from "@k2b/ssr/nav";
import {
  Button,
  createChartCursor,
  DashboardPanel as DashboardFrame,
  DashboardGrid,
  DashboardSection,
  DateTimePicker,
  NoticeCard,
  PanelHeader,
  RangePicker,
  StatGrid,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, ErrorBoundary, For, Show } from "solid-js";
import type { Dashboard, DashboardPanel, DashboardRange } from "../../dashboard-contracts";
import type { Overview } from "../../overview-contracts";
import { usePulseMessages } from "../use-messages";
import DashboardPanelView from "./DashboardPanelView";
import { createDashboardActions, type DashboardActions } from "./dashboard-actions";
import type { DashboardTarget, PublicDashboardPanel } from "./dashboard-client";
import { dashboardRangeSearch } from "./dashboard-client";
import { createDashboardController } from "./dashboard-controller";
import { dashboardDateTime, dashboardSections, dashboardTopNumbers } from "./dashboard-data";
import { dashboardStyles } from "./dashboard-styles";

export type DashboardViewProps = {
  name: string;
  panels: (PublicDashboardPanel | DashboardPanel)[];
  target: DashboardTarget;
  range: DashboardRange;
  path: string;
  /** The base's time zone: every time on the dashboard and the custom range read in it. */
  timeZone: string;
  actions?: DashboardActions;
  private?: { dashboard: Dashboard; base: { id: string; name: string }; canWrite: boolean; overview?: Overview | null };
};
export default function DashboardView(props: DashboardViewProps) {
  const t = usePulseMessages(),
    locale = useLocale();
  const c = createDashboardController({ target: props.target, panels: props.panels, range: props.range });
  const clock = () => ({ locale: locale(), timeZone: props.timeZone });
  const cursor = createChartCursor({ formatX: (x) => dashboardDateTime(clock()).format(x) });
  const sections = createMemo(() => dashboardSections(props.panels));
  const stats = createMemo(() => dashboardTopNumbers(props.panels));
  const [custom, setCustom] = createSignal(!!props.range.from);
  const [from, setFrom] = createSignal<string | null>(props.range.from ?? null);
  const [to, setTo] = createSignal<string | null>(props.range.to ?? null);
  const [invalidRange, setInvalidRange] = createSignal(false);
  const actions = props.actions ?? (props.private ? createDashboardActions(props.private) : null);
  createEffect(() => {
    if (c.denied()) {
      actions?.setDenied(true);
      actions?.dispose();
    }
  });
  const rangeHref = (range: DashboardRange) => {
    const url = new URL(props.path, "https://pulse.invalid");
    for (const key of ["range", "from", "to"]) url.searchParams.delete(key);
    for (const [key, value] of new URLSearchParams(dashboardRangeSearch(range))) url.searchParams.set(key, value);
    return `${url.pathname}${url.search}`;
  };
  const results = () => Object.values(c.results());
  const loading = () =>
    props.panels.some((panel) => {
      const result = c.results()[panel.id];
      return !result || (!result.lastGood && result.status !== "error");
    });
  const outages = () => results().some((result) => result.error === "STORE_UNAVAILABLE");
  const attention = () => props.private?.overview?.attention.items ?? [];
  const attentionLabels = () =>
    attention().map(
      (item) =>
        `${item.name}${item.key ? ` ${item.key}` : ""} ${item.state === "stale" ? t().overviewStale : item.severity === "critical" ? t().overviewCritical : item.state === "error" ? t().overviewStateError : t().overviewWarning}`,
    );
  const lastGood = () =>
    results()
      .flatMap((result) => (result.lastGood ? [result.lastGood.at] : []))
      .sort()[0];
  const timestamp = () => (lastGood() ? dashboardDateTime(clock()).format(new Date(lastGood()!)) : "");
  // A panel that cannot render its result fails alone; the island boundary would blank the whole dashboard.
  const renderPanel = (panel: PublicDashboardPanel | DashboardPanel) => (
    <ErrorBoundary
      fallback={(error: unknown, reset) => {
        globalThis.reportError(error);
        return (
          <DashboardFrame
            class="pulse-dashboard__panel"
            data-panel={panel.id}
            data-kind={panel.kind}
            width={panel.width}
            aria-label={panel.title}
          >
            <div class="pulse-dashboard__panel-head">
              <h3>{panel.title}</h3>
            </div>
            <div class="pulse-dashboard__feedback" role="alert">
              <strong>{t().dashboardPanelFailed}</strong>
              <p class="text-sm text-secondary">{t().dashboardInvalidResult}</p>
              <Button variant="secondary" size="sm" disabled={c.pending().length > 0} onClick={() => void c.refresh(panel.id).then(reset)}>
                {t().retry}
              </Button>
            </div>
          </DashboardFrame>
        );
      }}
    >
      <DashboardPanelView
        panel={panel}
        result={c.results()[panel.id]}
        pending={c.pending().includes(panel.id)}
        retryDisabled={c.pending().length > 0}
        cursor={cursor}
        timeZone={props.timeZone}
        retry={() => void c.refresh(panel.id)}
        private={!!props.private}
      />
    </ErrorBoundary>
  );
  // Key figures stay one row of tiles, in their section or, without one, above every section.
  const Tiles = (tiles: { panels: (PublicDashboardPanel | DashboardPanel)[] }) => (
    <StatGrid columns={4} class="pulse-dashboard__stats">
      <For each={tiles.panels}>{renderPanel}</For>
    </StatGrid>
  );
  return (
    <div class="pulse-dashboard" data-print-region>
      <style>{dashboardStyles}</style>
      <PanelHeader
        as="h1"
        size="lg"
        title={props.name}
        class={props.actions ? "sr-only" : props.private ? "pulse-dashboard__heading" : undefined}
        actions={
          actions && !props.actions ? (
            <div class="pulse-dashboard__compact-actions">
              <actions.Buttons compact />
            </div>
          ) : undefined
        }
      />
      <Show
        when={!c.denied()}
        fallback={
          <NoticeCard tone="warning" title={t().dashboardDenied} detail={t().dashboardUnavailableDetail}>
            <Button variant="secondary" onClick={() => window.location.reload()}>
              {t().retry}
            </Button>
          </NoticeCard>
        }
      >
        <div class="pulse-dashboard__toolbar">
          <RangePicker
            label={null}
            ariaLabel={t().dashboardRange}
            value={props.range.from ? "custom" : (props.range.range ?? "24h")}
            options={[
              ...(["24h", "7d", "30d", "90d"] as const).map((range) => ({
                value: range,
                label: { "24h": t().dashboard24h, "7d": t().dashboard7d, "30d": t().dashboard30d, "90d": t().dashboard90d }[range],
                href: rangeHref({ range }),
              })),
              ...(props.range.from ? [{ value: "custom", label: t().dashboardCustom, href: rangeHref(props.range) }] : []),
            ]}
          />
          <div class="pulse-dashboard__actions">
            <Show when={props.private}>
              <Button variant="ghost" onClick={() => setCustom((value) => !value)} aria-expanded={custom()}>
                {t().dashboardCustom}
              </Button>
            </Show>
            <Show when={actions && !c.denied()}>
              <div class="pulse-dashboard__desktop-actions">{actions && <actions.Buttons />}</div>
            </Show>
          </div>
        </div>
        <Show when={custom()}>
          <form
            class="pulse-dashboard__custom"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                !from() ||
                !to() ||
                !Number.isFinite(Date.parse(from()!)) ||
                !Number.isFinite(Date.parse(to()!)) ||
                Date.parse(from()!) >= Date.parse(to()!)
              ) {
                setInvalidRange(true);
                return;
              }
              navigateTo(rangeHref({ range: props.range.range, from: new Date(from()!).toISOString(), to: new Date(to()!).toISOString() }));
            }}
          >
            {/* Wall-clock time in the base's zone, which the picker panel names; both emit exact instants. */}
            <DateTimePicker label={t().dashboardFrom} value={from()} onValueChange={setFrom} dateConfig={{ timeZone: props.timeZone }} />
            <DateTimePicker label={t().dashboardTo} value={to()} onValueChange={setTo} dateConfig={{ timeZone: props.timeZone }} />
            <Button type="submit" variant="secondary">
              {t().dashboardApplyRange}
            </Button>
            <Show when={invalidRange()}>
              <p role="alert" class="w-full text-sm text-[var(--k2b-danger-text)]">
                {t().dashboardInvalidRange}
              </p>
            </Show>
          </form>
        </Show>
        <Show when={actions?.assistantError()}>
          <NoticeCard role="alert" tone="danger" title={t().sqlAssistantFailureTitle}>
            <Button variant="secondary" disabled={actions?.assistantPending()} onClick={() => void actions?.askAssistant()}>
              {t().retry}
            </Button>
          </NoticeCard>
        </Show>
        <div
          class="pulse-dashboard__band"
          role="status"
          data-loading={loading()}
          data-error={outages()}
          data-attention={attention().length > 0}
          data-critical={attention().some((item) => item.severity === "critical" || item.state === "error")}
        >
          <i
            class={`ti ${outages() ? "ti-cloud-off" : loading() ? "ti-loader-2" : attention().length ? "pulse-dashboard__status-dot" : "ti-circle-check"}`}
            aria-hidden="true"
          />
          <p>
            <strong>
              {outages()
                ? t().dashboardStoreUnavailable
                : loading()
                  ? t().dashboardLoading
                  : attention().length
                    ? attentionLabels()[0]
                    : t().dashboardReady}
            </strong>
            <Show when={!loading() && !outages() && attentionLabels().length > 1}>
              <span>
                {"\u00a0· "}
                {attentionLabels().slice(1).join("\u00a0· ")}
              </span>
            </Show>
            <Show when={lastGood()}>
              <span title={timestamp()}>
                {"\u00a0· "}
                {outages() ? t().dashboardLastGood : t().overviewAsOf}: {timestamp()}
              </span>
            </Show>
            {"\u00a0· "}
            {t().overviewEveryMinute}
          </p>
          <Show when={outages()}>
            <Button variant="subtle" size="sm" disabled={!!c.pending().length} onClick={() => void c.refresh()}>
              {t().retry}
            </Button>
          </Show>
        </div>
        <Show
          when={props.panels.length}
          fallback={
            <div class="pulse-dashboard__empty">
              <h2>{t().dashboardEmpty}</h2>
              <p>{t().dashboardNoRows}</p>
            </div>
          }
        >
          <DashboardGrid>
            <Show when={stats().length}>
              <Tiles panels={stats()} />
            </Show>
            <For each={sections()}>
              {(section) => (
                <DashboardSection
                  title={section.name || undefined}
                  ariaLabel={props.name}
                  icon={section.icon}
                  iconColor={section.color}
                  description={section.description}
                >
                  <Show when={section.numbers.length}>
                    <Tiles panels={section.numbers} />
                  </Show>
                  <For each={section.panels}>{renderPanel}</For>
                </DashboardSection>
              )}
            </For>
          </DashboardGrid>
        </Show>
      </Show>
    </div>
  );
}
