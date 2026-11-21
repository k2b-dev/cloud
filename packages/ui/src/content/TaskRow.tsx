import { createSignal, type JSX, Show } from "solid-js";
import { Dynamic, isServer } from "solid-js/web";
import { Tooltip } from "../feedback/Tooltip";

export type TaskRowProps = {
  /** Tabler icon class for the kind of task, such as `ti ti-package-export`. Decorative: the sentence names the task. */
  icon: string;
  /** How many things the task covers, as a chip before the sentence. Zero shows no chip; the sentence says it in words. */
  count?: number;
  /** The task in one sentence, such as "3 unsold items are ready for pickup". One line; a longer one ends in an ellipsis. */
  text: string;
  /** A quiet second line, such as the date the task is due. The row is then 52 px instead of 40 px. */
  detail?: JSX.Element;
  /** The action word at the end, such as "Prepare handover". It is never cut; the sentence gives way first. */
  action: string;
  /** Where the row leads. The row is then a link. */
  href?: string;
  /** What the row does when there is no `href`. The row is then a button. */
  onClick?: (event: MouseEvent) => void;
  /** The task cannot be started now. The row stays in place, reads as unavailable and does nothing. */
  disabled?: boolean;
  /**
   * The accessible name, when the visible text alone does not say what happens. Defaults to the row's text. Start it
   * with the visible sentence and action word, so people who speak a visible word can still reach the row.
   */
  label?: string;
  class?: string;
};

/**
 * A task that only has a date, such as items waiting for pickup until a day: the kind as a symbol, the count as a
 * chip, one sentence and, at the end, the action word. The whole row is one link or button. What needs someone now
 * and has a consequence is a notice cell instead (K10), not a task row.
 * @example <TaskRow icon="ti ti-package-export" count={3} text="Unsold items are ready for pickup" detail="until Dec 12, 2026" action="Prepare handover" href="/handover" />
 */
export function TaskRow(props: TaskRowProps): JSX.Element {
  let row: HTMLElement | undefined;
  let body: HTMLSpanElement | undefined;
  let sentence: HTMLSpanElement | undefined;
  // The full sentence shows as a hint only while it is cut; it is measured when a pointer or the keyboard arrives.
  const [cut, setCut] = createSignal(false);
  const measure = () => setCut(Boolean(sentence && sentence.scrollWidth > sentence.clientWidth + 1));
  const link = () => props.href !== undefined && !props.disabled;
  const element = () => (props.href !== undefined ? "a" : "button");

  return (
    <Dynamic
      component={element()}
      ref={(node: HTMLElement) => {
        row = node;
      }}
      class={props.class ? `k2b-task-row ${props.class}` : "k2b-task-row"}
      href={link() ? props.href : undefined}
      type={element() === "button" ? "button" : undefined}
      disabled={element() === "button" ? props.disabled : undefined}
      role={props.disabled && element() === "a" ? "link" : undefined}
      aria-disabled={props.disabled && element() === "a" ? "true" : undefined}
      aria-label={props.label}
      data-detail={props.detail !== undefined ? "" : undefined}
      // The no-JavaScript hint; once hydrated, the shared tooltip shows the sentence, and only while it is cut.
      title={isServer ? props.text : undefined}
      onClick={(event: MouseEvent) => {
        if (props.disabled) {
          event.preventDefault();
          return;
        }
        props.onClick?.(event);
      }}
      on:pointerenter={measure}
      on:focusin={measure}
    >
      <span ref={body} class="k2b-task-row__body">
        <i class={`${props.icon} k2b-task-row__icon`} aria-hidden="true" />
        <span class="k2b-task-row__copy">
          <span class="k2b-task-row__line">
            <Show when={props.count}>
              <span class="k2b-count-chip">{props.count}</span>
            </Show>
            <span ref={sentence} class="k2b-task-row__text">
              {props.text}
            </span>
          </span>
          <Show when={props.detail !== undefined}>
            <span class="k2b-task-row__detail">{props.detail}</span>
          </Show>
        </span>
        <span class="k2b-task-row__action">{props.action}</span>
        {/* Inside the row, so a container that divides its rows (`k2b-divided`) sees only rows. The row keeps the
              focus; the hint is hidden from its name, which already holds the sentence. */}
        <Tooltip content={props.text} target={() => body} focusTarget={() => row} disabled={!cut()} />
      </span>
    </Dynamic>
  );
}

export default TaskRow;
