import { For, Index, Show } from "solid-js";
import { useUiMessages } from "../intl/messages";
import { ActionButton, Button } from "./button";
import { Icon } from "./marks";
import type { Action } from "./types";

// The three states every place that shows data has, in the place where the data will stand (design guide "Zustände"):
// empty, loading and failed. None draws a box; each stands where the list, the table or the content would stand, so
// the head and the status row above it never move.

export type EmptyProps = {
  /** A Tabler icon for the round sign, such as `inbox`. */
  icon: string;
  /** One sentence that says what is the matter: "Noch keine Einlieferung." is not "Keine Treffer mit diesem Filter." */
  text: string;
  /** The one way out, such as "Einlieferung erfassen" or "Filter zurücksetzen". */
  action?: Action;
};

/** Nothing here: a round sign, one sentence, one way out, without a box (mockup: Notice · Empty). */
export const Empty = (props: EmptyProps) => (
  <div class="k2-state" data-k2-part="Empty">
    <span class="k2-sign">
      <Icon name={props.icon} />
    </span>
    <span class="k2-state-text">{props.text}</span>
    <Show when={props.action}>{(action) => <ActionButton action={action()} />}</Show>
  </div>
);

export type FailedProps = {
  /**
   * What could not be loaded and what stays as it is, such as "Unterhaltungen konnten nicht geladen werden. Deine
   * Ansicht und Auswahl bleiben erhalten."
   */
  text: string;
  /** Loads again; the button says "Erneut versuchen" in the language of the page. */
  onRetry: () => void;
};

/**
 * Loading failed: the shape of `Empty` with a sign in the tone of wrong, the sentence, and "Erneut versuchen". It
 * replaces only the data; the selection and the view around it stay. (A connection that retries on its own shows in
 * the status row instead, without a button; something a person must fix is a `Notice` that names the deed.)
 */
export const Failed = (props: FailedProps) => {
  const t = useUiMessages();
  return (
    <div class="k2-state" data-k2-part="Failed" role="alert">
      <span class="k2-sign" data-tone="bad">
        <Icon name="alert-circle" />
      </span>
      <span class="k2-state-text">{props.text}</span>
      <Button icon="refresh" onClick={() => props.onRetry()}>
        {t().retry}
      </Button>
    </div>
  );
};

export type LoadingProps = {
  /** How many rows hold the place; 3 when not set. Give as many as usually come, so nothing moves when they arrive. */
  rows?: number;
  /** The lines of the rows that will come, so each placeholder is exactly as high as its row (40, 52 or 72). */
  lines?: 1 | 2 | 3;
};

/**
 * Loading: square placeholders in the heights of the real rows, so nothing moves when the data arrives. It stands
 * where the `List` will stand; a `Table` takes `loading` itself and keeps its head. Assistive technology hears
 * "loading" once.
 */
export const Loading = (props: LoadingProps) => {
  const t = useUiMessages();
  return (
    <div class="k2-list k2-loading" data-k2-part="Loading" role="status" aria-busy="true" aria-label={t().loading}>
      <PlaceholderRows rows={props.rows ?? 3} lines={props.lines ?? 1} />
    </div>
  );
};

/** Rows of placeholders in the shape of `Row` (internal: `Loading` and the phone list of a loading `Table`). */
export const PlaceholderRows = (props: { rows: number; lines: 1 | 2 | 3 }) => (
  <Index each={Array.from({ length: Math.max(0, props.rows) })}>
    {() => (
      <div class="k2-row" data-lines={String(props.lines)} aria-hidden="true">
        <span class="k2-row-lead" />
        <For each={(["l1", "l2", "l3"] as const).slice(0, props.lines)}>
          {(line) => (
            <span class={`k2-row-${line}`}>
              <span class="k2-skel" />
            </span>
          )}
        </For>
      </div>
    )}
  </Index>
);
