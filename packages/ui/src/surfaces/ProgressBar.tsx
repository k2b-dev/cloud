import type { JSX } from "solid-js";
import type { IntentTone } from "../semantics";

export type ProgressBarTone = Extract<IntentTone, "info" | "success" | "warning" | "danger">;

export type ProgressBarProps = {
  value: number;
  size?: "xs" | "sm" | "md";
  tone?: ProgressBarTone;
  showValue?: boolean;
  label: string;
  class?: string;
};

const clamp = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0);

export function ProgressBar(props: ProgressBarProps): JSX.Element {
  const percent = () => clamp(props.value);
  return (
    <div class={`k2b-progress ${props.class ?? ""}`} data-size={props.size ?? "md"} data-tone={props.tone ?? "info"}>
      <div
        class="k2b-progress__track"
        role="progressbar"
        aria-label={props.label}
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={percent()}
      >
        <div class="k2b-progress__value" style={`width: ${percent()}%`} />
      </div>
      {props.showValue ? <span class="k2b-progress__percent">{percent()}%</span> : null}
    </div>
  );
}

export default ProgressBar;
