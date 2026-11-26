import { For, type JSX, children as resolveChildren, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Button } from "./button";
import { linkOr } from "./link";
import { Count, custom, Icon } from "./marks";
import type { Action, TwoActions } from "./types";

const HeadActions = (props: { actions?: TwoActions }) => (
  <For each={props.actions}>
    {(action) => (
      <Button
        variant="text"
        icon={action.icon}
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
  /** The way to all of it, at the end ("All deliveries ›"). */
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
    <section class="k2-sec" data-k2-part="Section" aria-label={props.title}>
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
          <span class="k2-sh-count">
            <Count value={props.count ?? ""} />
          </span>
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

export type GroupProps = {
  /** A Tabler icon before the title. */
  icon?: string;
  /** The data colour of the group's area. */
  color?: string;
  /** The title of the group, such as a number. */
  title: string;
  /** A quiet count after the title. */
  count?: number | string;
  /** A quiet line under the title; the head grows from 40 to 56 px. */
  meta?: JSX.Element;
  /** A state at the end of the head, such as `<Text weight="medium"><Icon name="gavel" /> Läuft</Text>` or an amount. */
  state?: JSX.Element;
  /** More deeds of the group behind one "…" button. (The menu opens with the behaviour layer.) */
  menu?: Action;
  /** At most two text buttons at the end of the head; more deeds go into `menu`. */
  actions?: TwoActions;
  /**
   * Only the head with its result; the content is hidden, and a chevron at the end opens it. (Opening comes with the
   * behaviour layer.)
   */
  folded?: boolean;
  /** What belongs together: text, `Steps`, a small `Table`, `Facts`, rows; never another group. */
  children?: JSX.Element;
};

/**
 * The one framed group: what belongs together (a delivery, the items of one consignor, a thread). A square frame of
 * one hairline, a tinted head, and no line inside: entries are told apart by spacing alone. Never nested.
 */
export const Group = (props: GroupProps) => {
  // parts passed as JSX are made once and read from here
  const meta = resolveChildren(() => props.meta);
  const state = resolveChildren(() => props.state);
  return (
    <section class="k2-group" data-k2-part="Group" aria-label={props.title} data-folded={props.folded ? "" : undefined}>
      <div class="k2-gh" data-meta={meta() !== undefined ? "" : undefined}>
        <Show when={props.icon} fallback={<span />}>
          {(name) => (
            <Show when={props.color} fallback={<Icon name={name()} />}>
              <span class="k2-stile" style={custom({ "--k2-c": props.color })}>
                <Icon name={name()} />
              </span>
            </Show>
          )}
        </Show>
        <span class="k2-gh-title">
          {props.title}
          <Show when={props.count !== undefined}>
            <span class="k2-gh-count">
              <Count value={props.count ?? ""} />
            </span>
          </Show>
        </span>
        <Show when={meta() !== undefined}>
          <span class="k2-gh-meta">{meta()}</span>
        </Show>
        <Show when={state() !== undefined || props.actions?.length || props.menu || props.folded}>
          <span class="k2-gh-end">
            {state()}
            <Show when={props.menu}>
              {(menu) => (
                <Button
                  variant="ghost"
                  icon={menu().icon ?? "dots"}
                  label={menu().label}
                  href={menu().href}
                  onNavigate={menu().onNavigate}
                  onClick={() => menu().onClick?.()}
                  disabled={menu().disabled}
                />
              )}
            </Show>
            <HeadActions actions={props.actions} />
            <Show when={props.folded}>
              <Button variant="ghost" icon="chevron-down" label={props.title} />
            </Show>
          </span>
        </Show>
      </div>
      <Show when={!props.folded}>{props.children}</Show>
    </section>
  );
};
