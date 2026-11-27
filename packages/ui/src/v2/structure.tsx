import { For, type JSX, children as resolveChildren, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Button } from "./button";
import { linkOr } from "./link";
import { custom, Icon } from "./marks";
import type { Action, TwoActions } from "./types";

/** The text buttons at the end of a head (a section's, a group's). */
export const HeadActions = (props: { actions?: TwoActions }) => (
  <For each={props.actions}>
    {(action) => (
      <Button
        variant="text"
        icon={action.icon}
        // on the phone the head keeps only the symbol: the words stay the button's name and hint
        title={action.icon ? action.label : undefined}
        forward={action.forward}
        href={action.href}
        onNavigate={action.onNavigate}
        onClick={() => action.onClick?.()}
        disabled={action.disabled}
      >
        {action.label}
      </Button>
    )}
  </For>
);

export type SectionProps = {
  /** The symbol of the section. With `color` it stands on a tinted tile, otherwise plain. */
  icon?: string;
  /** The data colour of the section's area, such as the colour of deliveries. */
  color?: string;
  /** The title of the section. */
  title: string;
  /** A quiet count after the title. */
  count?: number | string;
  /** At most two text buttons in the head; on the phone they keep only their symbol. */
  actions?: TwoActions;
  /** One sentence under the head that sums the section up. */
  summary?: JSX.Element;
  /**
   * Its head, its sentence and its rows stay at the reading measure of `Prose` (720 px of text), so in a wide pane a
   * short list stays together instead of its words standing at the left edge and its deeds at the right. The section's
   * line still reaches the edges of its column. Below the measure it changes nothing.
   */
  measure?: boolean;
  /**
   * The way to all of it ("All deliveries ›"): under the rows, its words on their text edge (after the symbol where the
   * section has one), never at the right. In a side column it is a row of its own.
   */
  more?: Action;
  /** `Row`s, a `Digest`, `Facts` or `Group`s. */
  children?: JSX.Element;
};

/**
 * A section: a head with symbol, title, count and at most two text buttons. Rule 9: no line under the head, none
 * between the entries, one line at the end.
 */
export const Section = (props: SectionProps) => {
  const summary = resolveChildren(() => props.summary);
  return (
    <section class="k2-sec" data-k2-part="Section" aria-label={props.title} data-measure={props.measure ? "" : undefined}>
      <div class="k2-sh">
        <Show when={props.icon}>
          {(name) => (
            <Show when={props.color} fallback={<Icon name={name()} />}>
              <span class="k2-stile" style={custom({ "--k2-c": props.color })}>
                <Icon name={name()} />
              </span>
            </Show>
          )}
        </Show>
        <h3>{props.title}</h3>
        <Show when={props.count !== undefined}>
          <span class="k2-sh-count">{props.count}</span>
        </Show>
        <Show when={props.actions?.length}>
          <span class="k2-sh-end">
            <HeadActions actions={props.actions} />
          </span>
        </Show>
      </div>
      <Show when={summary() !== undefined}>
        <p class="k2-sec-summary">{summary()}</p>
      </Show>
      {props.children}
      <Show when={props.more}>
        {(more) => (
          // One link: a quiet text button at the end of a section; a row with its summary in a side column. A disabled
          // link is an anchor without an address, as in `Button`.
          <Dynamic
            component={more().disabled && more().href !== undefined ? "a" : linkOr(more().href, "button")}
            type={more().href !== undefined ? undefined : "button"}
            class="k2-sec-link"
            href={more().disabled ? undefined : more().href}
            onNavigate={more().href !== undefined && !more().disabled ? more().onNavigate : undefined}
            disabled={more().href === undefined ? more().disabled : undefined}
            aria-disabled={more().href !== undefined && more().disabled ? "true" : undefined}
            onClick={() => {
              if (!more().disabled) more().onClick?.();
            }}
          >
            <b>{more().label}</b>
            <Show when={more().meta}>
              <span class="k2-sec-link-meta">{more().meta}</span>
            </Show>
            <Icon name="chevron-right" />
          </Dynamic>
        )}
      </Show>
    </section>
  );
};
