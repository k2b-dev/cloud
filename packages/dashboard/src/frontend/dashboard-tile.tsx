import type { WidgetBlock } from "@k2b/cloud/contracts";
import {
  Button,
  Placeholder,
  useLocale,
  Widget,
  WidgetHero,
  WidgetList,
  WidgetPills,
  WidgetStat,
  WidgetStatus,
  type WidgetStatusTone,
} from "@k2b/ui";
import { createEffect, createSignal, type JSX, Match, on, onCleanup, Switch } from "solid-js";
import { isServer } from "solid-js/web";
import type { DashboardCatalogWidget } from "../shared";
import { dashboardMessages } from "./messages";
import type { DashboardTileState } from "./widget-board";

/** After this long a loading widget says that its app is slow; Core ends its budget at eight seconds. */
export const DASHBOARD_SLOW_WIDGET_MS = 3_000;

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

/**
 * One widget in the frame its size reserves. Loading, a slow app, failure, a locked or empty widget, and the answer
 * all render inside the same frame, so nothing around it moves when the state changes.
 */
export function DashboardWidgetFrame(props: { widget: DashboardCatalogWidget; state: DashboardTileState; onRetry?: () => void }) {
  const locale = useLocale();
  const t = () => dashboardMessages.resolve([locale()]).t;
  const [slow, setSlow] = createSignal(false);
  if (!isServer)
    createEffect(
      on(
        () => props.state.status,
        (status) => {
          setSlow(false);
          if (status !== "loading") return;
          const timer = setTimeout(() => setSlow(true), DASHBOARD_SLOW_WIDGET_MS);
          onCleanup(() => clearTimeout(timer));
        },
      ),
    );
  const frame = (children: JSX.Element) => (
    <Widget title={props.widget.title} icon={props.widget.appIcon} href={props.widget.appHref} size="fill">
      {children}
    </Widget>
  );
  const state = (children: JSX.Element) => frame(<div class="dashboard-widget-state">{children}</div>);
  const loaded = () => (props.state.status === "ok" ? props.state.widget : undefined);
  return (
    <Switch>
      <Match when={loaded()}>
        {(widget) => (
          <Widget title={widget().title} icon={widget().icon ?? props.widget.appIcon} href={widget().href} meta={widget().meta} size="fill">
            {widget().blocks.map((block) => renderBlock(block))}
          </Widget>
        )}
      </Match>
      <Match when={props.state.status === "loading"}>
        {state(
          <Placeholder
            state="loading"
            title={t().widgetLoading}
            // The slow notice has its line from the start, so showing it moves nothing.
            description={
              <span class="dashboard-widget-slow" data-shown={slow() ? "true" : undefined}>
                {t().widgetSlow({ app: props.widget.appName })}
              </span>
            }
            variant="compact"
            class="dashboard-widget-placeholder"
          />,
        )}
      </Match>
      <Match when={props.state.status === "timeout" || props.state.status === "error"}>
        {state(
          <Placeholder
            state="error"
            variant="compact"
            title={
              props.state.status === "timeout"
                ? t().widgetTimeout({ app: props.widget.appName })
                : t().widgetFailed({ app: props.widget.appName })
            }
            action={
              props.onRetry ? (
                <Button variant="secondary" size="sm" onClick={() => props.onRetry?.()}>
                  {t().widgetRetry}
                </Button>
              ) : undefined
            }
            class="dashboard-widget-placeholder"
          />,
        )}
      </Match>
      <Match when={props.state.status === "forbidden"}>
        {state(<Placeholder icon="ti ti-lock" title={t().widgetForbidden} variant="compact" class="dashboard-widget-placeholder" />)}
      </Match>
      <Match when={props.state.status === "empty"}>
        {state(<Placeholder title={t().widgetEmpty} variant="compact" class="dashboard-widget-placeholder" />)}
      </Match>
    </Switch>
  );
}
