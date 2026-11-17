import { type JSX, Show } from "solid-js";

/** Internal cells shared by chat activities, composer tasks, and run steps. The owning surface supplies its grid. */
export function StepRowContent(props: {
  classes: { leading: string; label: string; meta?: string; duration?: string };
  leading: JSX.Element;
  label: JSX.Element;
  meta?: JSX.Element;
  metaTone?: string;
  duration?: string;
  durationTitle?: string;
  silentDuration?: boolean;
  end?: JSX.Element;
  statusLabel?: string;
}) {
  return (
    <>
      <span class={props.classes.leading} aria-hidden="true">
        {props.leading}
      </span>
      <span class={props.classes.label}>{props.label}</span>
      <Show when={props.meta}>
        <span class={props.classes.meta} data-tone={props.metaTone}>
          {props.meta}
        </span>
      </Show>
      <Show when={props.duration}>
        <span class={props.classes.duration} title={props.durationTitle} aria-hidden={props.silentDuration ? "true" : undefined}>
          {props.duration}
        </span>
      </Show>
      {props.end}
      <Show when={props.statusLabel}>
        <span class="k2b-sr-only">{props.statusLabel}</span>
      </Show>
    </>
  );
}
