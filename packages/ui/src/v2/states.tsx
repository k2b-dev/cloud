import { For, Index, type JSX, children as resolveChildren, Show } from "solid-js";
import { useUiMessages } from "../intl/messages";
import { ActionButton } from "./button";
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
  /** The way out, such as "Einlieferung erfassen" or "Filter zurücksetzen". */
  action?: Action;
  /** A second, quieter way out after the first, such as "Ganzes Notizbuch zeigen"; a text button. */
  secondary?: Action;
};

/**
 * Nothing here: a round sign, one sentence, a way out, without a box (mockup: Notice · Empty). A second way out stands
 * after the first, quieter; the first stays first, so it is the one a focus that comes to the state reaches.
 */
export const Empty = (props: EmptyProps) => (
  <div class="k2-state" data-k2-part="Empty">
    <span class="k2-sign">
      <Icon name={props.icon} />
    </span>
    <span class="k2-state-text">{props.text}</span>
    <Show when={props.action || props.secondary}>
      <span class="k2-state-ways">
        <Show when={props.action}>{(action) => <ActionButton action={action()} />}</Show>
        <Show when={props.secondary}>{(secondary) => <ActionButton action={secondary()} variant="text" />}</Show>
      </span>
    </Show>
  </div>
);

// `Failed` has a module of its own (see failed.tsx); it stays one of the three states here.
export { Failed, type FailedProps } from "./failed";

export type LoadingProps = {
  /** How many rows hold the place; 3 when not set. Give as many as usually come, so nothing moves when they arrive. */
  rows?: number;
  /** The lines of the rows that will come, so each placeholder is exactly as high as its row (40, 52 or 72). */
  lines?: 1 | 2 | 3;
};

/**
 * Loading: square placeholders in the heights of the real rows, so nothing moves when the data arrives. It stands
 * where the `List` will stand; a `Table` takes `loading` itself and keeps its head. For a drawing, such as a chart,
 * it stands inside the drawing's `Canvas` (with a `height`) and is one placeholder as high as it, like `Empty` and
 * `Failed` there. Assistive technology hears
 * "Wird geladen…" (in the language of the page) from a status line; the placeholders themselves are hidden from it.
 */
export const Loading = (props: LoadingProps) => (
  <div class="k2-list k2-loading" data-k2-part="Loading">
    <LoadingStatus />
    <PlaceholderRows rows={props.rows ?? 3} lines={props.lines ?? 1} />
  </div>
);

/** The words "loading" for assistive technology only (internal: `Loading` and a loading `Table`). */
export const LoadingStatus = () => {
  const t = useUiMessages();
  return (
    <span class="k2-hidden-text" role="status">
      {t().loading}
    </span>
  );
};

/**
 * A value still on its way (internal: a loading `Facts` and `Cells.Cell`): a quiet bar exactly one line of the value
 * high, so nothing moves when the value comes; assistive technology hears "loading" at its place.
 */
export const PlaceholderValue = (props: {
  /** The value the place holds while a newer one comes (a refresh): it keeps its room, unseen, under the bar. */
  children?: JSX.Element;
  /** `false`: no words for assistive technology, for a second line of the same value (a cell's meta). */
  said?: boolean;
}) => {
  const t = useUiMessages();
  const held = resolveChildren(() => props.children);
  const holds = () => {
    const value = held();
    return value !== undefined && value !== null && value !== false && value !== "" && !(Array.isArray(value) && value.length === 0);
  };
  return (
    <>
      {/* a value that is there keeps its exact room (lines, chips, wrapping); only a value not yet there is one line */}
      <Show when={holds()} fallback={<span class="k2-skel" aria-hidden="true" />}>
        <span class="k2-held" aria-hidden="true">
          {held()}
        </span>
        <span class="k2-skel" data-over="" aria-hidden="true" />
      </Show>
      <Show when={props.said !== false}>
        <span class="k2-hidden-text">{t().loading}</span>
      </Show>
    </>
  );
};

/** Rows of placeholders in the shape of `Row` (internal: `Loading` and the phone list of a loading `Table`). */
export const PlaceholderRows = (props: { rows: number; lines: 1 | 2 | 3 }) => (
  <Index each={Array.from({ length: Math.max(0, props.rows) })}>
    {() => (
      <div class="k2-row" data-lines={String(props.lines)} aria-hidden="true">
        <span class="k2-row-lead" />
        <For each={(["k2-row-l1", "k2-row-l2", "k2-row-l3"] as const).slice(0, props.lines)}>
          {(line) => (
            <span class={line}>
              <span class="k2-skel" />
            </span>
          )}
        </For>
      </div>
    )}
  </Index>
);
