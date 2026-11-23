import { For, type JSX, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { ActionButton } from "./button";
import { Avatar, Chip, custom, Dot, Icon } from "./marks";
import type { Action, Person, Status } from "./types";

// Layer 2: components made only of the primitives. They exist where a form must be the same everywhere.

// ── Nav ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export type NavItem = {
  label: string;
  icon: string;
  href?: string;
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
    component={props.item.href || !props.item.onClick ? "a" : "button"}
    href={props.item.href}
    onClick={() => props.item.onClick?.()}
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

export type Tab = { label: string; icon?: string; count?: number | string; href?: string; current?: boolean; menu?: boolean };

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
          <a class="k2-tab" href={tab.href} aria-current={tab.current ? "page" : undefined}>
            <Show when={tab.icon}>{(name) => <Icon name={name()} />}</Show>
            {tab.label}
            <Show when={tab.count !== undefined}>
              <span class="k2-tab-count">{tab.count}</span>
            </Show>
            <Show when={tab.menu}>
              <Icon name="chevron-down" />
            </Show>
          </a>
        )}
      </For>
    </div>
  </nav>
);

// ── StatusRow ────────────────────────────────────────────────────────────────────────────────────────────────────

export type StatusFact = { before?: string; value: string | number; after?: string };

export type StatusRowProps = {
  /** The one main statement, such as "7 unread". */
  lead: string;
  /** Key figures after it; they leave on the phone. */
  facts?: readonly StatusFact[];
  /** A box at the start that selects all entries. */
  select?: { label: string; checked?: boolean | "mixed" };
  /** Filters or a segment at the end. */
  filters?: JSX.Element;
};

/** The status row of a pane (52 px): the one lead statement, key figures, filters on the right. */
export const StatusRow = (props: StatusRowProps) => (
  <div class="k2-bar" data-k2-part="StatusRow" data-status-row="">
    <div class="k2-bar-start">
      <Show when={props.select}>
        {(select) => (
          <span class="k2-mark">
            <input
              class="k2-mark-input"
              type="checkbox"
              aria-label={select().label}
              checked={select().checked === true}
              aria-checked={select().checked === "mixed" ? "mixed" : undefined}
            />
            <span class="k2-check" data-checked={select().checked ? "" : undefined} data-k2-mark="">
              <Show when={select().checked}>
                <Icon name={select().checked === "mixed" ? "minus" : "check"} />
              </Show>
            </span>
          </span>
        )}
      </Show>
      <span class="k2-status-lead">{props.lead}</span>
      <For each={props.facts}>
        {(fact) => (
          <span class="k2-fact">
            {fact.before ? `${fact.before} ` : ""}
            <b>{fact.value}</b>
            {fact.after ? ` ${fact.after}` : ""}
          </span>
        )}
      </For>
    </div>
    <Show when={props.filters !== undefined}>
      <div class="k2-bar-end">{props.filters}</div>
    </Show>
  </div>
);

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
  actions?: readonly Action[];
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
        <For each={props.actions?.slice(0, 2)}>{(action) => <ActionButton action={action} variant="text" />}</For>
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
  /** One sentence about it; `<Text strong>` stresses a word. */
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
export const Digest = (props: DigestProps) => (
  <div class="k2-list k2-digest" data-k2-part="Digest" role="list" aria-label={props.label}>
    <Show when={props.items} fallback={props.children}>
      {(items) => (
        <For each={items()}>
          {(entry) => (
            <Dynamic
              component={entry.href ? "a" : "div"}
              href={entry.href}
              class="k2-row"
              data-k2-part="Digest.Entry"
              data-digest=""
              role="listitem"
              style={custom({ "--k2-c": entry.color })}
            >
              <>
                <span class="k2-row-lead">
                  <Icon name={entry.icon} />
                </span>
                <span class="k2-digest-date">{entry.date}</span>
                <span class="k2-row-l1">{entry.title}</span>
                <span class="k2-digest-state">
                  <Icon name={entry.state.icon} tone={entry.state.tone} />
                  {entry.state.label}
                </span>
                <span class="k2-digest-text">{entry.text}</span>
                <i class="ti ti-chevron-right k2-icon k2-digest-go" aria-hidden="true" />
              </>
            </Dynamic>
          )}
        </For>
      )}
    </Show>
  </div>
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
