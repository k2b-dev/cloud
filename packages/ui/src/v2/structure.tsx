import { createSignal, For, type JSX, children as resolveChildren, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { useDisclosure } from "./behavior/files";
import { Button } from "./button";
import { linkOr } from "./link";
import { custom, Icon } from "./marks";
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
  /** An anchor for a link to this section, such as `screen` for `/me#screen`; unique on the page. */
  id?: string;
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
    <section class="k2-sec" data-k2-part="Section" id={props.id} aria-label={props.title}>
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
   * Starts as only the head with its result; the content is hidden, and the chevron at the end opens and closes it
   * (a button that says whether the group is open).
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
  // a folded group opens and closes in place; one that is not folded has no toggle
  const [open, setOpen] = createSignal(!props.folded);
  const fold = useDisclosure(() => ({ defaultOpen: !props.folded, onOpenChange: setOpen }));
  return (
    <section class="k2-group" data-k2-part="Group" aria-label={props.title} data-folded={props.folded && !open() ? "" : undefined}>
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
            <span class="k2-gh-count">{props.count}</span>
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
              <fold.Trigger
                class="k2-btn"
                data-k2-part="Button"
                data-variant="ghost"
                data-icon-only=""
                data-fold=""
                aria-label={props.title}
                title={props.title}
              >
                <Icon name="chevron-down" />
              </fold.Trigger>
            </Show>
          </span>
        </Show>
      </div>
      <Show when={props.folded} fallback={props.children}>
        <fold.Panel class="k2-group-body">{props.children}</fold.Panel>
      </Show>
    </section>
  );
};

export type DisclosureProps = {
  /** The question or the name of what is hidden; it is the button that opens and closes it. */
  title: string;
  /** Whether it is open. With `onOpenChange` the caller holds it; without, it starts so and keeps its own state. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** What opens: `Text`, `Prose`, `Facts`, a few rows. */
  children: JSX.Element;
};

/**
 * Something that opens in place, such as the answer to a question: a row of 44 px with the title and a chevron at the
 * end, the content under it on the text edge. A closed answer stays in the page (`hidden="until-found"`), so the
 * browser's find in page reaches it and opens it. Several stand one under the other in a `Section`, without lines.
 */
export const Disclosure = (props: DisclosureProps) => {
  const parts = useDisclosure(() => ({
    ...(props.onOpenChange ? { open: props.open === true } : { defaultOpen: props.open === true }),
    onOpenChange: (open: boolean) => props.onOpenChange?.(open),
  }));
  return (
    <parts.Root class="k2-disc" data-k2-part="Disclosure">
      <parts.Trigger class="k2-disc-head">
        <span class="k2-disc-title">{props.title}</span>
        <Icon name="chevron-down" />
      </parts.Trigger>
      <parts.Panel class="k2-disc-body" hiddenUntilFound>
        {props.children}
      </parts.Panel>
    </parts.Root>
  );
};
