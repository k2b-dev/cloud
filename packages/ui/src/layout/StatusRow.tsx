import { For, type JSX, Show } from "solid-js";
import { useUiMessages } from "../intl/messages";

/** A key figure of the status row: the number (bold) and what it counts. */
export type StatusRowFact = { value: JSX.Element; label: JSX.Element };

/** A page-wide disturbance that needs nobody: the page tries again by itself (K10). */
export type StatusRowState = {
  /** What is wrong, in a few words, such as "Sync paused". */
  label: JSX.Element;
  /** `warning` (the default) or `danger`; `neutral` for a quiet state such as "Offline". */
  tone?: "neutral" | "warning" | "danger";
  /** Tabler icon class inside the round sign, such as `ti ti-refresh`. Defaults to an alert sign. */
  icon?: string;
  /** The time of the next attempt as people read it, such as "14:05". Shows as "next attempt 14:05". */
  next?: JSX.Element;
};

/** A selection in the list below: its count and the actions on it, in the place of the key figures and filters. */
export type StatusRowSelection = {
  /** The number of chosen items. */
  count: number;
  /** Actions on the chosen items, usually small buttons. */
  actions?: JSX.Element;
};

export type StatusRowProps = {
  /** The lead statement (18 px, bold): what someone wants to know here first. It is never shortened. */
  lead: JSX.Element;
  /** Up to three key figures. Only the first three show; the rest give way in a fixed order when space is short. */
  facts?: readonly StatusRowFact[];
  /** Filters at the end of the row, usually `FilterChip` elements. */
  filters?: JSX.Element;
  /** A disturbance of the whole page; it takes the place of the key figures, the lead statement stays. */
  state?: StatusRowState;
  /** A selection; its count and actions take the place of the key figures and filters. */
  selection?: StatusRowSelection;
  /**
   * What is happening right now in words, announced politely to screen readers and shown in the place of the key
   * figures, such as "Moving “Invoice 12” to Done". Drag and drop fills it while an item moves (K7).
   */
  announcement?: JSX.Element;
  /** A hairline under the row, where the row stands above a list without its own column head. */
  line?: boolean;
  class?: string;
};

const present = (value: unknown) => value !== undefined && value !== null && value !== false && value !== "";

/**
 * The status row (K6, K10): the first line under a column's head, 52 px tall. The lead statement on the left keeps
 * its place and size in every state. Up to three key figures follow it; on the right stand the filters. A selection
 * shows its count and actions in the same places; a disturbance of the page shows a round sign, what is wrong, and
 * the next attempt in the place of the key figures. It shows only data that exists already.
 */
export function StatusRow(props: StatusRowProps): JSX.Element {
  const messages = useUiMessages();
  const mode = () => (props.selection ? "selection" : present(props.announcement) ? "announcement" : props.state ? "state" : "facts");
  return (
    <div
      class={`k2b-status-row${props.class ? ` ${props.class}` : ""}`}
      data-mode={mode()}
      data-tone={props.state && !props.selection ? (props.state.tone ?? "warning") : undefined}
      data-line={props.line ? "" : undefined}
    >
      <p class="k2b-status-row__lead">{props.lead}</p>
      <div class="k2b-status-row__middle">
        <Show when={mode() === "facts"}>
          <For each={(props.facts ?? []).slice(0, 3)}>
            {(fact) => (
              <span class="k2b-status-row__fact">
                <b>{fact.value}</b> {fact.label}
              </span>
            )}
          </For>
        </Show>
        <Show when={mode() === "state" && props.state}>
          {(state) => (
            <span class="k2b-status-row__state">
              <span class="k2b-status-row__sign" aria-hidden="true">
                <i class={state().icon ?? "ti ti-alert-triangle"} />
              </span>
              <b>{state().label}</b>
              <Show when={present(state().next)}>
                <span class="k2b-status-row__next">
                  {messages().statusNextAttempt} {state().next}
                </span>
              </Show>
            </span>
          )}
        </Show>
        <Show when={mode() === "selection" && props.selection}>
          {(selection) => (
            <span class="k2b-status-row__fact k2b-status-row__count">
              <b>{messages().statusSelected({ count: selection().count })}</b>
            </span>
          )}
        </Show>
        <Show when={mode() === "announcement"}>
          <span class="k2b-status-row__announcement">{props.announcement}</span>
        </Show>
      </div>
      <Show when={mode() === "selection" ? present(props.selection?.actions) : present(props.filters)}>
        <div class="k2b-status-row__end">{mode() === "selection" ? props.selection?.actions : props.filters}</div>
      </Show>
      {/* The live region exists from the first frame, so the first announcement is heard. */}
      <span class="k2b-sr-only" aria-live="polite" aria-atomic="true">
        {props.announcement}
      </span>
    </div>
  );
}

export default StatusRow;
