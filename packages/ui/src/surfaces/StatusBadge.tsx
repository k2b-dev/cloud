import { For, type JSX, Show } from "solid-js";

export type StatusTone = "info" | "ok" | "warning" | "error" | "degraded" | "running" | "neutral";

export type StatusBadgeProps = {
  tone: StatusTone;
  label: JSX.Element;
  icon?: string | null;
  variant?: "chip" | "dot" | "text";
  /**
   * Every label this place can show, such as all states of a list's status. The badge keeps the width of the longest,
   * so in a right-aligned slot its dot starts at one x in every row and stays put when the state changes.
   */
  labels?: readonly string[];
  title?: string;
  class?: string;
};

const DEFAULT_ICONS: Record<StatusTone, string> = {
  info: "ti ti-info-circle",
  ok: "ti ti-check",
  warning: "ti ti-alert-triangle",
  error: "ti ti-alert-circle",
  degraded: "ti ti-plug-connected-x",
  running: "ti ti-loader-2",
  neutral: "ti ti-alert-square-rounded",
};

export function StatusBadge(props: StatusBadgeProps): JSX.Element {
  const variant = () => props.variant ?? "chip";
  const icon = () => (props.icon === null ? undefined : (props.icon ?? DEFAULT_ICONS[props.tone]));
  return (
    <span class={`k2b-status-badge ${props.class ?? ""}`} data-tone={props.tone} data-variant={variant()} title={props.title}>
      <Show when={variant() !== "dot"} fallback={<span class="k2b-status-badge__dot" aria-hidden="true" />}>
        <Show when={icon()}>{(glyph) => <i class={glyph()} aria-hidden="true" />}</Show>
      </Show>
      <Show when={props.labels?.length} fallback={<span class="k2b-status-badge__label">{props.label}</span>}>
        <span class="k2b-status-badge__label" data-reserve="">
          <span>{props.label}</span>
          <For each={props.labels}>{(label) => <span aria-hidden="true">{label}</span>}</For>
        </span>
      </Show>
    </span>
  );
}

export default StatusBadge;
