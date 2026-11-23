import { createMemo, For, type JSX, children as resolveChildren, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { ActionButton } from "./button";
import { RowOpen } from "./content";
import { MarkCheck } from "./controls";
import { Avatar, Chip, custom, Dot, Icon } from "./marks";
import { type Action, navigate, type OnNavigate, type Person, type Status, type TwoActions } from "./types";

// Layer 2: components made only of the primitives. They exist where a form must be the same everywhere.

// ── Nav ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export type NavItem = {
  label: string;
  icon: string;
  href?: string;
  /** With `href`: opens the page in place on a plain click (see `OnNavigate`). */
  onNavigate?: OnNavigate;
  onClick?: () => void;
  count?: number | string;
  /** The open one. */
  current?: boolean;
  /** One level in, such as the folders of a mailbox. */
  nested?: boolean;
  /** Something new here. */
  dot?: Status;
};

export type NavGroup = { label?: string; action?: Action; items: readonly NavItem[] };

export type NavProps = {
  /** The app's name and symbol at the top. */
  title: string;
  icon: string;
  groups: readonly NavGroup[];
  /** Entries at the foot, such as "Hidden (2)". */
  foot?: readonly NavItem[];
};

const NavEntry = (props: { item: NavItem }) => (
  <Dynamic
    component={props.item.href !== undefined ? "a" : "button"}
    type={props.item.href !== undefined ? undefined : "button"}
    href={props.item.href}
    onClick={(event: MouseEvent) => {
      props.item.onClick?.();
      if (props.item.href !== undefined) navigate(props.item.onNavigate, event);
    }}
    class="k2-ni"
    data-k2-part="Nav.Item"
    aria-current={props.item.current ? "page" : undefined}
    data-level={props.item.nested ? "2" : undefined}
  >
    <Icon name={props.item.icon} />
    <span class="k2-ni-name">{props.item.label}</span>
    <Show when={props.item.dot}>{(status) => <Dot status={status()} />}</Show>
    <Show when={props.item.count !== undefined}>
      <span class="k2-ni-count">{props.item.count}</span>
    </Show>
  </Dynamic>
);

/** The sidebar of an app: its name, groups of round entries with counts, entries at the foot. */
export const Nav = (props: NavProps) => (
  <nav class="k2-nav" data-k2-part="Nav" aria-label={props.title}>
    <div class="k2-nav-title">
      <Icon name={props.icon} />
      {props.title}
    </div>
    <For each={props.groups}>
      {(group) => (
        <>
          <Show when={group.label}>
            <div class="k2-nav-label">
              {group.label}
              <Show when={group.action}>{(action) => <ActionButton action={action()} variant="ghost" iconOnly />}</Show>
            </div>
          </Show>
          <For each={group.items}>{(item) => <NavEntry item={item} />}</For>
        </>
      )}
    </For>
    <Show when={props.foot?.length}>
      <div class="k2-nav-foot">
        <For each={props.foot}>{(item) => <NavEntry item={item} />}</For>
      </div>
    </Show>
  </nav>
);

// ── Tabs ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type Tab = {
  label: string;
  icon?: string;
  count?: number | string;
  /** The tab leads to this page … */
  href?: string;
  /** … opens it in place on a plain click, while the link still opens in a new tab (see `OnNavigate`) … */
  onNavigate?: OnNavigate;
  /** … or switches the view in place. */
  onClick?: () => void;
  current?: boolean;
  menu?: boolean;
};

export type TabsProps = { items: readonly Tab[]; label: string };

/**
 * The views of a head or of an object. In the start of a head bar they share it with the actions and give way to
 * them; as the head of a pane they are a bar of their own, 44 px. The open tab stands on the line of its bar. (The
 * keyboard comes with the behaviour layer.)
 */
export const Tabs = (props: TabsProps) => (
  <nav class="k2-tabs-nav" data-k2-part="Tabs" aria-label={props.label}>
    <div class="k2-tabs">
      <For each={props.items}>
        {(tab) => (
          <Dynamic
            component={tab.href !== undefined ? "a" : "button"}
            type={tab.href !== undefined ? undefined : "button"}
            class="k2-tab"
            href={tab.href}
            onClick={(event: MouseEvent) => {
              tab.onClick?.();
              if (tab.href !== undefined) navigate(tab.onNavigate, event);
            }}
            aria-current={tab.current ? "page" : undefined}
          >
            <Show when={tab.icon}>{(name) => <Icon name={name()} />}</Show>
            {tab.label}
            <Show when={tab.count !== undefined}>
              <span class="k2-tab-count">{tab.count}</span>
            </Show>
            <Show when={tab.menu}>
              <Icon name="chevron-down" />
            </Show>
          </Dynamic>
        )}
      </For>
    </div>
  </nav>
);

// ── Path ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Where a page stands, in the start of its head instead of tabs: the places before it quiet, the page itself in 600.
 * On the phone the head with a path gives way to the phone bar of the shell, which names the page.
 */
export type PathProps = { items: readonly { label: string; href?: string }[]; label: string };

export const Path = (props: PathProps) => (
  <nav class="k2-path" data-k2-part="Path" aria-label={props.label}>
    <For each={props.items}>
      {(item, index) => (
        <>
          <Show when={index() > 0}>
            <Icon name="chevron-right" />
          </Show>
          <Show
            when={index() === props.items.length - 1}
            fallback={
              <Show when={item.href !== undefined} fallback={<span class="k2-path-step">{item.label}</span>}>
                <a class="k2-path-step" href={item.href}>
                  {item.label}
                </a>
              </Show>
            }
          >
            <b aria-current="page">{item.label}</b>
          </Show>
        </>
      )}
    </For>
  </nav>
);

// ── StatusRow ────────────────────────────────────────────────────────────────────────────────────────────────────

/** A key figure: words before and after, the value itself in 600 (leave it out for words alone, such as "12 offen"). */
export type StatusFact = { before?: string; value?: string | number; after?: string };

export type StatusRowProps = {
  /** The one main statement, such as "7 unread". */
  lead: string;
  /** Key figures after it; they leave on the phone. */
  facts?: readonly StatusFact[];
  /** A box at the start that selects all entries. */
  select?: { label: string; checked?: boolean | "mixed"; onChange?: (checked: boolean) => void };
  /** Filters or a segment at the end; they leave on the phone. */
  filters?: JSX.Element;
  /**
   * While entries are selected the row becomes the bar of what can be done with them (rule 6): the count, the
   * actions, and the way out.
   */
  selection?: { count: string; actions: readonly Action[]; clear: Action };
};

/** The status row of a pane (52 px): the one lead statement, key figures, filters on the right. */
export const StatusRow = (props: StatusRowProps) => {
  const filters = resolveChildren(() => props.filters);
  return (
    <div class="k2-bar" data-k2-part="StatusRow" data-status-row="" data-selecting={props.selection ? "" : undefined}>
      <Show
        when={props.selection}
        fallback={
          <>
            <div class="k2-bar-start">
              <Show when={props.select}>
                {(select) => <MarkCheck label={select().label} checked={select().checked} onChange={select().onChange} />}
              </Show>
              <span class="k2-status-lead">{props.lead}</span>
              <For each={props.facts}>
                {(fact) => (
                  <span class="k2-fact">
                    {fact.before ?? ""}
                    {fact.before && fact.value !== undefined ? " " : ""}
                    <Show when={fact.value !== undefined}>
                      <b>{fact.value}</b>
                    </Show>
                    {fact.after ? ` ${fact.after}` : ""}
                  </span>
                )}
              </For>
            </div>
            <Show when={filters() !== undefined}>
              <div class="k2-bar-end">{filters()}</div>
            </Show>
          </>
        }
      >
        {(selection) => (
          <div class="k2-bar-start">
            <Show when={props.select}>
              {(select) => <MarkCheck label={select().label} checked={select().checked} onChange={select().onChange} />}
            </Show>
            <span class="k2-status-lead" aria-live="polite">
              {selection().count}
            </span>
            <For each={selection().actions}>{(action) => <ActionButton action={action} />}</For>
            <ActionButton action={selection().clear} variant="text" />
          </div>
        )}
      </Show>
    </div>
  );
};

// ── Notice ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type NoticeProps = {
  /** What it is: a note of a person, a summary by AI, something wrong, something waiting. */
  tone: "note" | "ai" | "bad" | "warn";
  /** A symbol other than the one of the tone, such as a pin for a pinned note. */
  icon?: string;
  /** A short title; the text then runs under it across the full width. */
  title?: string;
  /** Quiet words after the title: who and when. */
  meta?: string;
  /** Text buttons at the end; at most two. */
  actions?: TwoActions;
  children: JSX.Element;
};

const toneIcon = { note: "note", ai: "sparkles", bad: "alert-circle", warn: "alert-triangle" } as const;

/** A band with a sign, a sentence and its consequence, and at most two deeds. The tint is its edge. */
export const Notice = (props: NoticeProps) => (
  <div
    class="k2-notice"
    data-k2-part="Notice"
    data-tone={props.tone}
    data-title={props.title ? "" : undefined}
    role={props.tone === "bad" ? "alert" : "note"}
  >
    <Icon name={props.icon ?? toneIcon[props.tone]} />
    <Show when={props.title}>
      <span class="k2-notice-title">
        {props.title}
        <Show when={props.meta}>
          {" "}
          <span class="k2-notice-meta">· {props.meta}</span>
        </Show>
      </span>
    </Show>
    <span class="k2-notice-text">{props.children}</span>
    <Show when={props.actions?.length}>
      <span class="k2-notice-end">
        <For each={props.actions}>{(action) => <ActionButton action={action} variant="text" />}</For>
      </span>
    </Show>
  </div>
);

// ── Digest ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type DigestEntry = {
  icon: string;
  color?: string;
  /** A short date, such as "17. Nov.". */
  date: string;
  /** The number or name of the thing. */
  title: string;
  /** Its state: a symbol and a word. */
  state: { icon: string; label: string; tone?: Status };
  /** One sentence about it; `<Text weight="strong">` stresses a word. */
  text: JSX.Element;
  href?: string;
};

export type DigestProps =
  | { items: readonly DigestEntry[]; children?: never; label?: string }
  | { items?: never; children: JSX.Element; label?: string };

/**
 * The newest few on a first page, without lines (decided 22.11.): dated entries in a grid of date, number with state
 * and sentence, or plain rows whose second line is a sentence.
 */
export const Digest = (props: DigestProps) => {
  // the entries hold JSX (their sentence): made once, here
  const items = createMemo(() => props.items);
  return (
    <div class="k2-list k2-digest" data-k2-part="Digest" role="list" aria-label={props.label}>
      <Show when={items()} fallback={props.children}>
        {(list) => (
          <For each={list()}>
            {(entry) => (
              <div
                class="k2-row"
                data-k2-part="Digest.Entry"
                data-digest=""
                data-open={entry.href !== undefined ? "" : undefined}
                role="listitem"
                style={custom({ "--k2-c": entry.color })}
              >
                <span class="k2-row-lead">
                  <Icon name={entry.icon} />
                </span>
                <span class="k2-digest-date">{entry.date}</span>
                <span class="k2-row-l1">
                  <RowOpen href={entry.href}>{entry.title}</RowOpen>
                </span>
                <span class="k2-digest-state">
                  <Icon name={entry.state.icon} tone={entry.state.tone} />
                  {entry.state.label}
                </span>
                <span class="k2-digest-text">{entry.text}</span>
                <Show when={entry.href !== undefined}>
                  <i class="ti ti-chevron-right k2-icon k2-digest-go" aria-hidden="true" />
                </Show>
              </div>
            )}
          </For>
        )}
      </Show>
    </div>
  );
};

// ── Steps ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type Step = {
  label: string;
  /** A quiet line under the step, such as a date or "10 von 18". */
  meta?: string;
  /** Done (grey with a tick), the one running now (a blue ring), or still to come (empty). */
  state: "done" | "now" | "next";
};

/** A way of a few steps: done ones grey with a tick, the running one a blue ring, the coming ones empty. */
export type StepsProps = { items: readonly Step[]; label: string };

export const Steps = (props: StepsProps) => (
  <ol
    class="k2-steps"
    data-k2-part="Steps"
    data-k2-figure=""
    aria-label={props.label}
    style={custom({ "--k2-steps": String(props.items.length) })}
  >
    <For each={props.items}>
      {(step) => (
        <li class="k2-step" data-state={step.state} aria-current={step.state === "now" ? "step" : undefined}>
          <span class="k2-step-mark">
            <Show when={step.state === "done"}>
              <Icon name="check" />
            </Show>
          </span>
          <span class="k2-step-label">{step.label}</span>
          <Show when={step.meta}>
            <span class="k2-t-meta">{step.meta}</span>
          </Show>
        </li>
      )}
    </For>
  </ol>
);

// ── RecordHead ───────────────────────────────────────────────────────────────────────────────────────────────────

export type RecordId = { label?: string; value: string; icon?: string; copy?: boolean };

export type RecordHeadProps = {
  name: string;
  avatar?: Person;
  /** Kinds of the record, such as "Private". */
  kinds?: readonly string[];
  /** Identifiers and contact at a glance; they leave on the phone. */
  ids?: readonly RecordId[];
};

/** The identity of a record in its head: avatar, name, kinds, identifiers. Put it in the start of the head `Bar`. */
export const RecordHead = (props: RecordHeadProps) => (
  <>
    <Show when={props.avatar}>{(person) => <Avatar {...person()} />}</Show>
    <h1 class="k2-record-name" data-k2-part="RecordHead">
      {props.name}
    </h1>
    <For each={props.kinds}>{(kind) => <Chip>{kind}</Chip>}</For>
    <For each={props.ids}>
      {(id) => (
        <span class="k2-record-id">
          <Show when={id.icon && !id.label}>
            <Icon name={id.icon!} />
          </Show>
          <Show when={id.label}>{id.label} </Show>
          <Show when={id.label} fallback={id.value}>
            <b>{id.value}</b>
          </Show>
          <Show when={id.copy}>
            <Icon name="copy" />
          </Show>
        </span>
      )}
    </For>
  </>
);
