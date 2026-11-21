import { For, type JSX, Show } from "solid-js";
import { useUiMessages } from "../intl/messages";
import { useProgressPathMessages } from "./progress-path-messages";

export type ProgressPathStep = {
  /** What happens at this step, such as "Received". */
  label: string;
  /** A quiet second line, such as the day it happened or "not yet". */
  detail?: JSX.Element;
  /** Whether the step happened. A done step shows a check in a filled dot. */
  done?: boolean;
  /**
   * The one step the thing is at now. Its dot is a ring in the app colour, its name is bold, and screen readers hear
   * "current step". It wins over `done` and `icon`.
   */
  current?: boolean;
  /** Tabler icon class an open step shows in its dot, such as `ti ti-truck`. */
  icon?: string;
};

export type ProgressPathProps = {
  steps: readonly ProgressPathStep[];
  /** Accessible name of the list, such as "Path of the item". */
  label?: string;
  class?: string;
};

type StepState = "done" | "current" | "open";
const stateOf = (step: ProgressPathStep): StepState => (step.current ? "current" : step.done ? "done" : "open");

/**
 * The way of one thing through its stages: dots on one line, each stage with a name and a quiet line, done, now, or
 * open, such as where an item is on its way. The state is in the dot's form and in words for screen readers, never in
 * color alone. A column of 360 px or more lays the stages out side by side, a narrower one, such as a phone, one below
 * the other.
 * @example <ProgressPath steps={[{ label: "Received", detail: "Nov 7", done: true }, { label: "Packed", detail: "today", current: true }, { label: "Shipped", detail: "not yet", icon: "ti ti-truck" }]} />
 */
export function ProgressPath(props: ProgressPathProps): JSX.Element {
  const messages = useUiMessages();
  const pathMessages = useProgressPathMessages();
  return (
    <div class={props.class ? `k2b-progress-path ${props.class}` : "k2b-progress-path"}>
      <ol class="k2b-progress-path__list" aria-label={props.label} style={{ "--k2b-progress-path-count": props.steps.length }}>
        <For each={props.steps}>
          {(step) => (
            <li class="k2b-progress-path__step" data-state={stateOf(step)}>
              <span class="k2b-progress-path__marker" aria-hidden="true">
                <Show
                  when={stateOf(step) === "done"}
                  fallback={<Show when={stateOf(step) === "open" && step.icon}>{(icon) => <i class={icon()} />}</Show>}
                >
                  <i class="ti ti-check" />
                </Show>
              </span>
              <span class="k2b-progress-path__label">
                {step.label}
                <span class="k2b-sr-only">
                  ,{" "}
                  {stateOf(step) === "current"
                    ? pathMessages().current
                    : stateOf(step) === "done"
                      ? messages().progressDone
                      : messages().progressOpen}
                </span>
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
