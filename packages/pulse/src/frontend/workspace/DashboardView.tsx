import { navigateTo } from "@k2b/ssr/nav";
import { Avatar, Button, createChartCursor, DateTimePicker, IconButton, NoticeCard, PanelHeader, RangePicker, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { Dashboard, DashboardPanel, DashboardRange } from "../../dashboard-contracts";
import type { Overview } from "../../overview-contracts";
import { usePulseMessages } from "../use-messages";
import DashboardPanelView from "./DashboardPanelView";
import type { DashboardTarget, PublicDashboardPanel } from "./dashboard-client";
import { dashboardRangeSearch } from "./dashboard-client";
import { createDashboardController } from "./dashboard-controller";
import { dashboardSections } from "./dashboard-data";
import { createDashboardSharing } from "./dashboard-sharing";
import { dashboardStyles } from "./dashboard-styles";
import { launchPulseDashboardAssistant } from "./pulse-assistant-launch";

export type DashboardViewProps = {
  name: string;
  panels: (PublicDashboardPanel | DashboardPanel)[];
  target: DashboardTarget;
  range: DashboardRange;
  path: string;
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
  const [assistantPending, setAssistantPending] = createSignal(false);
  const [assistantError, setAssistantError] = createSignal(false);
  const sharing = props.private ? createDashboardSharing(props.private.dashboard) : null;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const askAssistant = async () => {
    if (!props.private || assistantPending() || c.denied()) return;
    setAssistantPending(true);
    setAssistantError(false);
    try {
      const result = await launchPulseDashboardAssistant({
        base: props.private.base,
        dashboard: props.private.dashboard,
        locale: locale(),
      });
      if (!disposed) navigateTo(result.href);
    } catch {
      if (!disposed) setAssistantError(true);
    } finally {
      if (!disposed) setAssistantPending(false);
    }
  };
  const rangeHref = (range: DashboardRange) => {
    const url = new URL(props.path, "https://pulse.invalid");
    for (const key of ["range", "from", "to"]) url.searchParams.delete(key);
    for (const [key, value] of new URLSearchParams(dashboardRangeSearch(range))) url.searchParams.set(key, value);
    return `${url.pathname}${url.search}`;
  };
  const results = () => Object.values(c.results());
  const loading = () =>
    c.pending().length > 0 ||
    (props.panels.length > 0 && results().length === 0) ||
    results().some((result) => result.status === "waiting" || result.status === "refreshing");
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
        class={props.private ? "pulse-dashboard__heading" : undefined}
        actions={
          props.private && !c.denied() ? (
            <div class="flex items-center gap-2 lg:hidden">
              <Show when={props.private.canWrite}>
                <IconButton label={t().dashboardShare} disabled={sharing?.pending()} onClick={() => void sharing?.open()}>
                  <i class="ti ti-share" aria-hidden="true" />
                </IconButton>
              </Show>
              <IconButton label={t().sqlAskAssistant} variant="ai" disabled={assistantPending()} onClick={() => void askAssistant()}>
                <i class="ti ti-sparkles" aria-hidden="true" />
              </IconButton>
            </div>
          ) : undefined
        }
      />
      <Show
        when={!c.denied()}
        fallback={
          <NoticeCard tone="warning" title={t().dashboardDenied} detail={t().dashboardDeniedDetail}>
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
            options={(["24h", "7d", "30d", "90d"] as const).map((range) => ({
              value: range,
              label: { "24h": t().dashboard24h, "7d": t().dashboard7d, "30d": t().dashboard30d, "90d": t().dashboard90d }[range],
              href: rangeHref({ range }),
            }))}
          />
          <div class="pulse-dashboard__actions">
            <Button variant="ghost" onClick={() => setCustom((value) => !value)} aria-expanded={custom()}>
              {t().dashboardCustom}
            </Button>
            <Show when={props.private && !c.denied()}>
              <div class="hidden gap-2 lg:flex">
                <Show when={props.private?.canWrite}>
                  <Button variant="ghost" disabled={sharing?.pending()} onClick={() => void sharing?.open()}>
                    <i class="ti ti-share" aria-hidden="true" />
                    {t().dashboardShare}
                  </Button>
                </Show>
                <Button variant="ai" disabled={assistantPending()} onClick={() => void askAssistant()}>
                  <i class="ti ti-sparkles" aria-hidden="true" />
                  {t().sqlAskAssistant}
                </Button>
              </div>
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
        <Show when={assistantError()}>
          <NoticeCard role="alert" tone="danger" title={t().sqlAssistantFailureTitle}>
            <Button variant="secondary" disabled={assistantPending()} onClick={() => void askAssistant()}>
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
            class={`ti ${outages() ? "ti-cloud-off" : loading() ? "ti-loader-2" : attention().length ? "ti-point" : "ti-circle-check"}`}
            aria-hidden="true"
          />
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
            <span>· {attentionLabels().slice(1).join(" · ")}</span>
          </Show>
          <Show when={lastGood()}>
            <span title={timestamp()}>
              · {outages() ? t().dashboardLastGood : t().overviewAsOf}: {timestamp()}
              <Show when={attention().length && !outages()}> · {t().overviewEveryMinute}</Show>
            </span>
          </Show>
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
