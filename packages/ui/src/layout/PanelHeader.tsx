import { type JSX, Show } from "solid-js";

export type PanelHeaderProps = {
  title: JSX.Element;
  subtitle?: JSX.Element;
  actions?: JSX.Element;
  as?: "h1" | "h2" | "h3";
  size?: "sm" | "md" | "lg";
  class?: string;
};

const Heading = (props: Pick<PanelHeaderProps, "as" | "size" | "title">): JSX.Element => {
  const className = `k2b-panel-header__title ${props.size === "md" ? "is-medium" : props.size === "lg" ? "is-large" : ""}`;
  if (props.as === "h1") return <h1 class={className}>{props.title}</h1>;
  if (props.as === "h3") return <h3 class={className}>{props.title}</h3>;
  return <h2 class={className}>{props.title}</h2>;
};

export function PanelHeader(props: PanelHeaderProps): JSX.Element {
  return (
    <div class={`k2b-panel-header ${props.class ?? ""}`} data-size={props.size ?? "sm"}>
      <div class="k2b-panel-header__copy">
        <Heading as={props.as} size={props.size} title={props.title} />
        <Show when={props.subtitle}>
          <p class="k2b-panel-header__subtitle">{props.subtitle}</p>
        </Show>
      </div>
      <Show when={props.actions}>
        <div class="k2b-panel-header__actions">{props.actions}</div>
      </Show>
    </div>
  );
}
