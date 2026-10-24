import { navigateTo } from "@k2b/ssr/nav";
import { Avatar, Button, createChartCursor, DateTimePicker, NoticeCard, PanelHeader, RangePicker, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { Dashboard, DashboardPanel, DashboardRange } from "../../dashboard-contracts";
import type { Overview } from "../../overview-contracts";
import { usePulseMessages } from "../use-messages";
import DashboardPanelView from "./DashboardPanelView";
import { createDashboardActions, type DashboardActions } from "./dashboard-actions";
import type { DashboardTarget, PublicDashboardPanel } from "./dashboard-client";
import { dashboardRangeSearch } from "./dashboard-client";
import { createDashboardController } from "./dashboard-controller";
import { dashboardSections } from "./dashboard-data";
import { dashboardStyles } from "./dashboard-styles";

export type DashboardViewProps = {
  name: string;
  panels: (PublicDashboardPanel | DashboardPanel)[];
  target: DashboardTarget;
  range: DashboardRange;
  path: string;
  actions?: DashboardActions;
  private?: { dashboard: Dashboard; base: { id: string; name: string }; canWrite: boolean; overview?: Overview | null };
};
export default function DashboardView(props: DashboardViewProps) {
  const t = usePulseMessages(),
    locale = useLocale();
  const c = createDashboardController({ target: props.target, panels: props.panels, range: props.range });
  const cursor = createChartCursor({
    formatX: (x) => new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(x) + " UTC",
  });
  const sections = createMemo(() => dashboardSections(props.panels));
  const stats = () => props.panels.filter((panel) => panel.kind === "number");
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
  const timestamp = () =>
    lastGood()
      ? new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(lastGood()!)) +
        " UTC"
      : "";
  const renderPanel = (panel: PublicDashboardPanel | DashboardPanel) => (
    <DashboardPanelView
      panel={panel}
      result={c.results()[panel.id]}
      pending={c.pending().includes(panel.id)}
      retryDisabled={c.pending().length > 0}
      cursor={cursor}
      retry={() => void c.refresh(panel.id)}
      private={!!props.private}
    />
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
            <Button variant="ghost" onClick={() => setCustom((value) => !value)} aria-expanded={custom()}>
              {t().dashboardCustom}
            </Button>
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
            <DateTimePicker label={t().dashboardFrom} value={from()} onValueChange={setFrom} dateConfig={{ timeZone: "UTC" }} />
            <DateTimePicker label={t().dashboardTo} value={to()} onValueChange={setTo} dateConfig={{ timeZone: "UTC" }} />
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
          <Show when={stats().length}>
            <div class="pulse-dashboard__stats">
              <For each={stats()}>{renderPanel}</For>
            </div>
          </Show>
          <For each={sections()}>
            {(section) => (
              <section class="pulse-dashboard__section" aria-label={section.name || props.name}>
                <Show when={section.name}>
                  <div class="pulse-dashboard__section-heading">
                    <Show when={section.icon}>
                      <span aria-hidden="true">
                        <Avatar
                          name={section.name}
                          icon={section.icon}
                          size="xs"
                          shape="square"
                          style={{
                            width: "26px",
                            height: "26px",
                            "border-radius": "8px",
                            ...(section.color
                              ? {
                                  color: `color-mix(in srgb, ${section.color} 72%, var(--k2b-text))`,
                                  background: `color-mix(in srgb, ${section.color} 16%, var(--k2b-surface))`,
                                }
                              : {}),
                          }}
                        />
                      </span>
                    </Show>
                    <h2>{section.name}</h2>
                    <Show when={section.description}>
                      <p class="pulse-dashboard__section-description">{section.description}</p>
                    </Show>
                  </div>
                </Show>
                <div class="pulse-dashboard__panels">
                  <For each={section.panels}>{renderPanel}</For>
                </div>
              </section>
            )}
          </For>
        </Show>
      </Show>
    </div>
  );
}
