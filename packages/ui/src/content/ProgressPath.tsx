import { For, type JSX, Show } from "solid-js";
import { useUiMessages } from "../intl/messages";

export type ProgressPathStep = {
  /** What happens at this step, such as "Received". */
  label: string;
  /** A quiet second line, such as the day it happened or "not yet". */
  detail?: JSX.Element;
  /** Whether the step happened. Done steps show a check and a colored line to the next step. */
  done?: boolean;
  /** Tabler icon class an open step shows in its circle, such as `ti ti-truck`. */
  icon?: string;
};

export type ProgressPathProps = {
  steps: readonly ProgressPathStep[];
  /** Accessible name of the list, such as "Path of the item". */
  label?: string;
  class?: string;
};

/**
 * The stages of one thing in order, each with a word and a quiet line, such as where an item is on its way. Done steps
 * carry a check; the words say the state, so color is never the only signal. Wide containers lay the steps out side
 * by side, narrow ones, such as a phone, one below the other.
 * @example <ProgressPath steps={[{ label: "Received", detail: "Nov 7", done: true }, { label: "Shipped", detail: "not yet", icon: "ti ti-truck" }]} />
 */
export function ProgressPath(props: ProgressPathProps): JSX.Element {
  const messages = useUiMessages();
  return (
    <div class={props.class ? `k2b-progress-path ${props.class}` : "k2b-progress-path"}>
      <ol class="k2b-progress-path__list" aria-label={props.label} style={{ "--k2b-progress-path-count": props.steps.length }}>
        <For each={props.steps}>
          {(step) => (
            <li class="k2b-progress-path__step" data-done={step.done ? "" : undefined}>
              <span class="k2b-progress-path__marker" aria-hidden="true">
                <Show when={step.done} fallback={<Show when={step.icon}>{(icon) => <i class={icon()} />}</Show>}>
                  <i class="ti ti-check" />
                </Show>
              </span>
              <span class="k2b-progress-path__label">
                {step.label}
                <span class="k2b-sr-only">, {step.done ? messages().progressDone : messages().progressOpen}</span>
              </span>
              <Show when={step.detail}>
                <span class="k2b-progress-path__detail">{step.detail}</span>
              </Show>
            </li>
          )}
        </For>
      </ol>
    </div>
  );
}

export default ProgressPath;
