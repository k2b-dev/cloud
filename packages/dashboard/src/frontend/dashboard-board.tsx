import { streamWidgets, type WidgetResponse } from "@k2b/cloud/browser/widgets";
import type { WidgetBlock } from "@k2b/cloud/contracts";
import {
  Button,
  Placeholder,
  useLocale,
  Widget,
  WidgetHero,
  WidgetList,
  WidgetPills,
  type WidgetSize,
  WidgetStat,
  WidgetStatus,
  type WidgetStatusTone,
} from "@k2b/ui";
import { createEffect, createSignal, For, type JSX, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { isServer } from "solid-js/web";
import { publishDashboardTiles } from "./board-store";
import { dashboardMessages } from "./messages";
import {
  applyDashboardWidgetLine,
  breakDashboardTiles,
  type DashboardTileState,
  type DashboardTiles,
  type DashboardWidgetHint,
  dashboardWidgetHintCookie,
  loadingDashboardTiles,
  nextDashboardWidgetHint,
  sameDashboardWidgetHint,
} from "./widget-board";

/** A widget the page reserves space for: the app's name and icon stand in until the widget answers. */
export type DashboardTile = { key: string; title: string; icon: string; href?: string };

export type DashboardBoardProps = {
  focusRows: DashboardTile[][];
  overviewRows: DashboardTile[][];
  context: DashboardTile[];
  /** Every widget to ask, including those the hint reserves no space for, so the hint stays current. */
  requestKeys: string[];
  hint: DashboardWidgetHint;
};

const widgetStatusTone = (tone: "ok" | "warn" | "error" | "info"): WidgetStatusTone => {
  switch (tone) {
    case "ok":
      return "success";
    case "warn":
      return "warning";
    case "error":
      return "danger";
    case "info":
      return "info";
  }
};

const renderBlock = (block: WidgetBlock): JSX.Element => {
  switch (block.kind) {
    case "stat":
      return (
        <WidgetStat
          value={block.value}
          label={block.label}
          sub={block.sub}
          valueClass={block.valueClass}
          accent={block.accent}
          grow={block.grow}
        />
      );
    case "list":
      return <WidgetList items={block.items} emptyMessage={block.emptyMessage} grow={block.grow} />;
    case "status":
      return (
        <div class="dashboard-widget-status">
          <WidgetStatus
            tone={widgetStatusTone(block.tone)}
            title={block.title}
            message={block.message}
            icon={block.icon}
            grow={block.grow}
          />
        </div>
      );
    case "pills":
      return (
        <div class="dashboard-widget-pills">
          <WidgetPills pills={block.pills} grow={block.grow} />
        </div>
      );
    case "placeholder":
      return (
        <Placeholder
          title={block.title}
          description={block.description}
          icon={block.icon}
          variant="compact"
          class="dashboard-widget-placeholder flex-1 justify-center"
        />
      );
    case "hero":
      return <WidgetHero title={block.title} subtitle={block.subtitle} icon={block.icon} tone={block.tone} />;
    default: {
      const _exhaustive: never = block;
      void _exhaustive;
      return null;
    }
  }
};

const LoadedWidget = (props: { tile: DashboardTile; widget: WidgetResponse; size: WidgetSize }) => (
  <Widget
    title={props.widget.title}
    icon={props.widget.icon ?? props.tile.icon}
    href={props.widget.href}
    meta={props.widget.meta}
    size={props.size}
  >
    {props.widget.blocks.map((block) => renderBlock(block))}
  </Widget>
);

/**
 * One widget in the space the page reserved for it. Every state uses the same fixed `size`, so loading, failure, and
 * the rare widget that turns out empty or locked all keep that space and nothing around it moves.
 */
const DashboardWidgetSlot = (props: { tile: DashboardTile; size: WidgetSize; state: DashboardTileState; onRetry: () => void }) => {
  const locale = useLocale();
  const t = () => dashboardMessages.resolve([locale()]).t;
  const loaded = () => (props.state.status === "ok" ? props.state.widget : undefined);
  let slot: HTMLDivElement | undefined;
  const frame = (children: JSX.Element) => (
    <Widget title={props.tile.title} icon={props.tile.icon} href={props.tile.href} size={props.size}>
      {children}
    </Widget>
  );
  return (
    // The slot takes focus when its retry button gives way to the loading state, so keyboard focus stays in place.
    <div ref={slot} tabIndex={-1} class="dashboard-widget-slot" data-widget={props.tile.key} data-state={props.state.status}>
      <Switch>
        <Match when={loaded()}>{(widget) => <LoadedWidget tile={props.tile} widget={widget()} size={props.size} />}</Match>
        <Match when={props.state.status === "loading"}>
          {frame(
            <Placeholder
              state="loading"
              title={t().widgetLoading}
              variant="compact"
              class="dashboard-widget-placeholder flex-1 justify-center"
            />,
          )}
        </Match>
        <Match when={props.state.status === "timeout" || props.state.status === "error"}>
          {frame(
            <Placeholder
              state="error"
              variant="compact"
              title={t().widgetUnavailable}
              description={props.state.status === "timeout" ? t().widgetTimeout : t().widgetLoadFailed}
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    slot?.focus({ preventScroll: true });
                    props.onRetry();
                  }}
                >
                  {t().widgetRetry}
                </Button>
              }
              class="dashboard-widget-placeholder flex-1 justify-center"
            />,
          )}
        </Match>
        <Match when={props.state.status === "forbidden"}>
          {frame(
            <Placeholder
              icon="ti ti-lock"
              title={t().inaccessible}
              variant="compact"
              class="dashboard-widget-placeholder flex-1 justify-center"
            />,
          )}
        </Match>
        <Match when={props.state.status === "empty"}>
          {frame(<Placeholder title={t().widgetEmpty} variant="compact" class="dashboard-widget-placeholder flex-1 justify-center" />)}
        </Match>
      </Switch>
    </div>
  );
};

/**
 * The widget board. The page renders every reserved widget as loading; in the browser one stream from Core fills
 * each widget as soon as its app answers, so a slow or failing app affects only its own widget.
 */
export default function DashboardBoard(props: DashboardBoardProps) {
  const locale = useLocale();
  const t = () => dashboardMessages.resolve([locale()]).t;
  const [tiles, setTiles] = createSignal<DashboardTiles>(loadingDashboardTiles({}, props.requestKeys));
  const requests = new Set<AbortController>();
  let hint = props.hint;

  const load = async (keys: readonly string[]) => {
    if (keys.length === 0) return;
    const controller = new AbortController();
    // Widgets this request still owes a line; a retry started meanwhile owns its widget from then on.
    const owed = new Set(keys);
    requests.add(controller);
    setTiles((current) => loadingDashboardTiles(current, keys));
    try {
      await streamWidgets({
        keys,
        signal: controller.signal,
        locale: locale(),
        onLine: (line) => {
          if (line.type !== "widget" || !owed.delete(line.key)) return;
          setTiles((current) => applyDashboardWidgetLine(current, line));
        },
      });
    } catch {
      // The widgets still loading fail on their own below, each with its own retry.
    } finally {
      requests.delete(controller);
    }
    if (controller.signal.aborted) return;
    setTiles((current) => breakDashboardTiles(current, [...owed]));
  };

  onMount(() => void load(props.requestKeys));
  onCleanup(() => {
    for (const controller of requests) controller.abort();
  });
  if (!isServer)
    createEffect(
      on(tiles, (current) => {
        publishDashboardTiles(current);
        // Every answer updates the hint at once, so it holds even when the user leaves before slow widgets answer.
        const next = nextDashboardWidgetHint(hint, current, props.requestKeys);
        if (sameDashboardWidgetHint(hint, next)) return;
        hint = next;
        document.cookie = dashboardWidgetHintCookie(next, location.protocol === "https:");
      }),
    );

  const slot = (size: WidgetSize) => (tile: DashboardTile) => (
    <DashboardWidgetSlot tile={tile} size={size} state={tiles()[tile.key] ?? { status: "loading" }} onRetry={() => void load([tile.key])} />
  );
  // The main columns use the standard frame and the side column the compact one, the sizes `@k2b/ui` defines.
  const rows = (rowsOf: DashboardTile[][]) => (
    <For each={rowsOf}>{(row) => <div class="dashboard-widget-row">{row.map(slot("standard"))}</div>}</For>
  );

  // Widgets the hint reserves no space for are still asked, so a widget that has content again appears on the next load.
  if (props.focusRows.length + props.overviewRows.length + props.context.length === 0)
    return <Placeholder surface="paper" variant="panel" description={t().emptyDescription} />;

  return (
    <div class={`dashboard-briefing-grid ${props.context.length > 0 ? "has-context" : ""}`}>
      <div class="dashboard-primary-column">
        <Show when={props.focusRows.length > 0}>
          <section aria-label={t().focusWidgets} class="dashboard-widget-zone dashboard-focus-zone">
            {rows(props.focusRows)}
          </section>
        </Show>
        <Show when={props.overviewRows.length > 0}>
          <section aria-label={t().overviewWidgets} class="dashboard-widget-zone">
            {rows(props.overviewRows)}
          </section>
        </Show>
      </div>
      <Show when={props.context.length > 0}>
        <aside aria-label={t().contextWidgets} class="dashboard-context-column">
          <For each={props.context}>{slot("compact")}</For>
        </aside>
      </Show>
    </div>
  );
}
