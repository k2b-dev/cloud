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
  /** The title of the section. */
  title: string;
  /** A quiet count after the title. */
  count?: number | string;
  /** At most two buttons in the head: framed, with their symbol and their verb, also on the phone. */
  actions?: TwoActions;
  /** One sentence that says what the section is for: the quiet line right under the title. */
  summary?: JSX.Element;
  /**
   * Its head, its sentence and its rows stay at the reading measure of `Prose` (720 px of text), so in a wide pane a
   * short list stays together instead of its words standing at the left edge and its deeds at the right. The section's
   * line still reaches the edges of its column. Below the measure it changes nothing.
   */
  measure?: boolean;
  /**
   * The way to all of it ("All deliveries ›"): under the rows, its words on their text edge, never at the right. In a
   * side column it is a row of its own.
   */
  more?: Action;
  /** `Row`s, a `Digest`, `Facts` or `Group`s. */
  children?: JSX.Element;
  /**
   * Whether the section is open. With `onOpenChange` the section can fold: a chevron at the end of its head opens and
   * closes it (a button that says whether it is open), and the caller holds the state, so it can keep it (without
   * `open` the section starts open and keeps its own state, told by `onOpenChange`). Folded, only the head stands,
   * with the section's line below it.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/**
 * A section: a calm head (title, a quiet count, the summary under it, at most two framed buttons at the end) and its
 * content. In a pane of 960 px and more its head takes a column of its own and the section keeps the measure of
 * 1040 px; a section of a table, tiles or a drawing keeps its full width. Rule 9: no line under the head, a hair
 * between the entries, one line at the end and none under the last section. A section that can fold keeps the same
 * head, rhythm and lines; the server and the first render show it as `open` says.
 */
export const Section = (props: SectionProps) => {
  const summary = resolveChildren(() => props.summary);
  // a section folds only where the caller holds its state; the others stay as they were, without a toggle or a body
  const fold = props.onOpenChange
    ? useDisclosure(() => ({
        // with `open` the caller holds the state; without, the section starts open and keeps its own
        ...(props.open === undefined ? { defaultOpen: true } : { open: props.open }),
        onOpenChange: (open: boolean) => props.onOpenChange?.(open),
      }))
    : undefined;
  const body = () => (
    <>
      {props.children}
      <SectionMore more={props.more} />
    </>
  );
  return (
    <section
      class="k2-sec"
      data-k2-part="Section"
      aria-label={props.title}
      data-measure={props.measure ? "" : undefined}
    >
      <div class="k2-sh" data-actions={props.actions?.length || undefined}>
        <div class="k2-sh-title">
          <h3>{props.title}</h3>
          <Show when={props.count !== undefined}>
            <span class="k2-sh-count">{props.count}</span>
          </Show>
        </div>
        <Show when={summary() !== undefined}>
          <p class="k2-sec-summary">{summary()}</p>
        </Show>
        <Show when={props.actions?.length || fold}>
          <span class="k2-sh-end">
            <HeadActions actions={props.actions} />
            {fold && (
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
            )}
          </span>
        </Show>
      </div>
      {fold ? <fold.Panel class="k2-sec-body">{body()}</fold.Panel> : body()}
    </section>
  );
};

/** The way to all of a section, at its end: one quiet link. */
const SectionMore = (props: { more?: Action }) => (
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
);

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
 * end, the content under it on the text edge, made only while it is open (as a folded `Group`), so the server and
 * the first render show the same. Several stand one under the other in a `Section`, without lines.
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
      <parts.Panel class="k2-disc-body">{props.children}</parts.Panel>
    </parts.Root>
  );
};
