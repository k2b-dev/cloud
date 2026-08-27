import { type JSX, Show } from "solid-js";
import { useUiMessages } from "../intl/messages";
import { Paper } from "../surfaces/Paper";
import Placeholder from "../surfaces/Placeholder";
import { PanelHeader } from "./PanelHeader";

export type DataPanelProps = {
  title: JSX.Element;
  subtitle?: JSX.Element;
  actions?: JSX.Element;
  search?: JSX.Element;
  filters?: JSX.Element;
  children?: JSX.Element;
  error?: string | null;
  empty?: JSX.Element;
  isEmpty?: boolean;
  footer?: JSX.Element;
  as?: "h1" | "h2";
  class?: string;
};

export function DataPanel(props: DataPanelProps): JSX.Element {
  const messages = useUiMessages();
  const hasToolbar = () => Boolean(props.search || props.filters);

  return (
    <Paper as="section" class={`k2b-data-panel ${props.class ?? ""}`}>
      <div class="k2b-data-panel__header">
        <PanelHeader title={props.title} subtitle={props.subtitle} actions={props.actions} as={props.as} />
        <Show when={hasToolbar()}>
          <div class="k2b-data-panel__toolbar">
            <Show when={props.search}>{props.search}</Show>
            <Show when={props.filters}>{props.filters}</Show>
          </div>
        </Show>
      </div>
      <Show
        when={!props.error}
        fallback={
          <Placeholder
            state="error"
            variant="compact"
            icon="ti ti-plug-connected-x"
            title={messages().couldNotLoadData}
            description={props.error ?? undefined}
          />
        }
      >
        <Show when={!props.isEmpty} fallback={<Placeholder variant="compact" description={props.empty ?? messages().nothingToShow} />}>
          {props.children}
        </Show>
      </Show>
      <Show when={props.footer}>
        <footer class="k2b-data-panel__footer">{props.footer}</footer>
      </Show>
    </Paper>
  );
}
