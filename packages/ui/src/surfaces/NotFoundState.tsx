import { type JSX, Show } from "solid-js";

export type NotFoundStateAction = {
  label: string;
  href: string;
  icon?: string;
};

export type NotFoundStateProps = {
  code?: string;
  title: string;
  description?: string;
  icon?: string;
  action?: NotFoundStateAction;
};

export function NotFoundState(props: NotFoundStateProps): JSX.Element {
  return (
    <div class="k2b-not-found">
      <Show
        when={props.code}
        fallback={<Show when={props.icon}>{(icon) => <i class={`${icon()} k2b-not-found__icon`} aria-hidden="true" />}</Show>}
      >
        {(code) => <div class="k2b-not-found__code">{code()}</div>}
      </Show>
      <div class="k2b-not-found__copy">
        <h1>{props.title}</h1>
        <Show when={props.description}>{(description) => <p>{description()}</p>}</Show>
      </div>
      <Show when={props.action}>
        {(action) => (
          <a href={action().href} class="k2b-button" data-size="sm" data-variant="primary">
            <i class={action().icon ?? "ti ti-home"} aria-hidden="true" />
            <span>{action().label}</span>
          </a>
        )}
      </Show>
    </div>
  );
}

export default NotFoundState;
