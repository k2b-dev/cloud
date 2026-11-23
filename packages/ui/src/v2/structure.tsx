import { For, type JSX, Show } from "solid-js";
import { Button } from "./button";
import { custom, Icon } from "./marks";
import type { Action } from "./types";

const HeadActions = (props: { actions?: readonly Action[] }) => (
  <For each={props.actions?.slice(0, 2)}>
    {(action) => (
      <Button variant="text" icon={action.icon} forward={action.forward} href={action.href} onClick={() => action.onClick?.()}>
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
  title: string;
  count?: number | string;
  /** At most two text buttons in the head; on the phone they keep only their symbol. */
  actions?: readonly Action[];
  /** One sentence under the head that sums the section up. */
  summary?: JSX.Element;
  /** The way to all of it, at the end ("All deliveries ›"). */
  more?: Action;
  children?: JSX.Element;
};

/**
 * A section: a head with symbol, title, count and at most two text buttons. Rule 9: no line under the head, none
 * between the entries, one line at the end.
 */
export const Section = (props: SectionProps) => (
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
        <span class="k2-sh-count">{props.count}</span>
      </Show>
      <Show when={props.actions?.length}>
        <span class="k2-sh-end">
          <HeadActions actions={props.actions} />
        </span>
      </Show>
    </div>
    <Show when={props.summary !== undefined}>
      <p class="k2-sec-summary">{props.summary}</p>
    </Show>
    {props.children}
    <Show when={props.more}>
      {(more) => (
        // One link: a quiet text button at the end of a section; a row with its summary in a side column.
        <a class="k2-sec-link" href={more().href} onClick={() => more().onClick?.()}>
          <b>{more().label}</b>
          <Show when={more().meta}>
            <span class="k2-sec-link-meta">{more().meta}</span>
          </Show>
          <Icon name="chevron-right" />
        </a>
      )}
    </Show>
  </section>
);

export type GroupProps = {
  icon?: string;
  color?: string;
  title: string;
  count?: number | string;
  /** A quiet line under the title; the head grows from 40 to 56 px. */
  meta?: JSX.Element;
  /** A state at the end of the head, such as `<Text medium><Icon name="gavel" /> Läuft</Text>` or an amount. */
  state?: JSX.Element;
  /** More deeds of the group behind one "…" button. (The menu opens with the behaviour layer.) */
  menu?: Action;
  /** Text buttons at the end of the head. */
  actions?: readonly Action[];
  /**
   * Only the head with its result; the content is hidden, and a chevron at the end opens it. (Opening comes with the
   * behaviour layer.)
   */
  folded?: boolean;
  children?: JSX.Element;
};

/**
 * The one framed group: what belongs together (a delivery, the items of one consignor, a thread). A square frame of
 * one hairline, a tinted head, and no line inside: entries are told apart by spacing alone. Never nested.
 */
export const Group = (props: GroupProps) => (
  <section class="k2-group" data-k2-part="Group" aria-label={props.title} data-folded={props.folded ? "" : undefined}>
    <div class="k2-gh" data-meta={props.meta !== undefined ? "" : undefined}>
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
          <span class="k2-gh-count">{props.count}</span>
        </Show>
      </span>
      <Show when={props.meta !== undefined}>
        <span class="k2-gh-meta">{props.meta}</span>
      </Show>
      <Show when={props.state !== undefined || props.actions?.length || props.menu || props.folded}>
        <span class="k2-gh-end">
          {props.state}
          <Show when={props.menu}>
            {(menu) => <Button variant="ghost" icon={menu().icon ?? "dots"} label={menu().label} onClick={() => menu().onClick?.()} />}
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
