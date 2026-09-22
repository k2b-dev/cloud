import { type JSX, Show } from "solid-js";
import Placeholder from "../surfaces/Placeholder";
import { PanelHeader } from "./PanelHeader";

export type AppOverviewProps = {
  title: string;
  subtitle?: string;
  icon: string;
  class?: string;
  children: JSX.Element;
};

export type AppOverviewPanelProps = {
  title: string;
  description?: JSX.Element;
  toolbar?: JSX.Element;
  class?: string;
  children: JSX.Element;
};

export type AppOverviewEmptyStateProps = {
  title: string;
  description?: JSX.Element;
  icon?: string;
  class?: string;
  children?: JSX.Element;
};

type AppOverviewComponent = ((props: AppOverviewProps) => JSX.Element) & {
  Main: (props: AppOverviewPanelProps) => JSX.Element;
  Aside: (props: AppOverviewPanelProps) => JSX.Element;
  EmptyState: (props: AppOverviewEmptyStateProps) => JSX.Element;
};

const tablerIconClass = (icon: string | null | undefined, fallback: string): string => {
  const value = icon?.trim() || fallback;
  return value.startsWith("ti ") ? value : `ti ${value}`;
};

const AppOverviewPanelHeader = (props: Pick<AppOverviewPanelProps, "title" | "description" | "toolbar">): JSX.Element => (
  <div class="k2b-app-overview__panel-header">
    <div>
      <h2>{props.title}</h2>
      <Show when={props.description}>
        <p>{props.description}</p>
      </Show>
    </div>
    <Show when={props.toolbar}>
      <div class="k2b-app-overview__toolbar">{props.toolbar}</div>
    </Show>
  </div>
);

const AppOverviewMain = (props: AppOverviewPanelProps): JSX.Element => (
  <section class={`k2b-app-overview__main ${props.class ?? ""}`}>
    <AppOverviewPanelHeader title={props.title} description={props.description} toolbar={props.toolbar} />
    {props.children}
  </section>
);

const AppOverviewAside = (props: AppOverviewPanelProps): JSX.Element => (
  <aside class={`k2b-app-overview__aside ${props.class ?? ""}`}>
    <AppOverviewPanelHeader title={props.title} description={props.description} toolbar={props.toolbar} />
    {props.children}
  </aside>
);

const AppOverviewEmptyState = (props: AppOverviewEmptyStateProps): JSX.Element => (
  <Placeholder
    surface="paper"
    variant="panel"
    title={props.title}
    description={props.description}
    icon={props.icon ? tablerIconClass(props.icon, "ti-inbox") : undefined}
    action={props.children}
    class={props.class}
  />
);

const AppOverview = ((props: AppOverviewProps): JSX.Element => (
  <div class={`k2b-app-overview ${props.class ?? ""}`}>
    <header class="k2b-app-overview__header">
      <span class="k2b-app-overview__icon" aria-hidden="true">
        <i class={tablerIconClass(props.icon, "ti-apps")} />
      </span>
      <PanelHeader as="h1" size="lg" title={props.title} subtitle={props.subtitle} />
    </header>
    <div class="k2b-app-overview__columns">{props.children}</div>
  </div>
)) as AppOverviewComponent;

AppOverview.Main = AppOverviewMain;
AppOverview.Aside = AppOverviewAside;
AppOverview.EmptyState = AppOverviewEmptyState;

export default AppOverview;
