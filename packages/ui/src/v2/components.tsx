import {
  createComputed,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Index,
  type JSX,
  onCleanup,
  onMount,
  children as resolveChildren,
  Show,
  untrack,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import { useLocale } from "../intl/locale";
import { useUiMessages } from "../intl/messages";
import { ActionButton } from "./button";
import { RowOpen } from "./content";
import { MarkCheck } from "./controls";
import { linkOr } from "./link";
import { Avatar, Chip, custom, Dot, Icon } from "./marks";
import { Menu, type MenuEntry, MenuTab } from "./menu";
import { useOverlayMessages } from "./overlay-messages";
import type { Action, OnNavigate, Person, Status, TwoActions } from "./types";

// Layer 2: components made only of the primitives. They exist where a form must be the same everywhere.

// ── Nav ──────────────────────────────────────────────────────────────────────────────────────────────────────────

type NavEntryBase = {
  /** The words of the entry. */
  label: string;
  /** A count at the end, such as unread mails. */
  count?: number | string;
  /** The open one. */
  current?: boolean;
  /** One level in, such as the folders of a mailbox. */
  nested?: boolean;
  /** Something new here. */
  dot?: Status;
};

/**
 * An entry of the sidebar: a place to go (`icon`, `href` or `onClick`), or, with `items`, entries tucked away under
 * one entry that folds open, such as "Mehr" with the archive, the bin and spam. A folding entry has a chevron in the
 * place of the symbol, starts open while one of its entries is the open one, and remembers nothing.
 */
export type NavItem = NavEntryBase &
  (
    | {
        /** A Tabler icon before the words. */
        icon: string;
        /** The page the entry leads to. */
        href?: string;
        /** With `href`: opens the page in place on a plain click (see `OnNavigate`). */
        onNavigate?: OnNavigate;
        /** A deed instead of a page, for what has no address. */
        onClick?: () => void;
        /**
         * The deeds of this entry, such as "Anheften" and "Ausblenden" of a mailbox: a "…" at its end that shows
         * under the pointer and with the keyboard's focus, always reached by Tab.
         */
        menu?: readonly MenuEntry[];
        items?: undefined;
      }
    | {
        /** The entries it folds away; they stand one level further in. */
        items: readonly NavItem[];
        icon?: undefined;
        href?: undefined;
        onNavigate?: undefined;
        onClick?: undefined;
        menu?: undefined;
      }
  );

export type NavGroup = {
  /** A quiet heading over the group, such as "Postfächer". */
  label?: string;
  /**
   * The group's one deed as a quiet icon button, or, with `items`, a "…" with the group's deeds, such as "Neues
   * Postfach" and "Gelöschte Postfächer"; `label` names the button.
   */
  action?: Action | { label: string; items: readonly MenuEntry[] };
  /** The entries of the group. */
  items: readonly NavItem[];
};

export type NavProps = {
  /** The app's name and symbol at the top. */
  title: string;
  /** A Tabler icon beside the app's name. */
  icon: string;
  /** The app's places in groups, each with an optional heading and deed. */
  groups: readonly NavGroup[];
  /** Entries at the foot, such as "Hidden (2)". */
  foot?: readonly NavItem[];
};

/** The level of an entry: a top entry 1, `nested` 2; the entries of a folding entry one further in. */
const levelOf = (item: NavItem, within?: number) => within ?? (item.nested ? 2 : 1);

const NavEnd = (props: { item: NavItem }) => (
  <>
    <span class="k2-ni-name">{props.item.label}</span>
    <Show when={props.item.dot}>{(status) => <Dot status={status()} />}</Show>
    <Show when={props.item.count !== undefined}>
      <span class="k2-ni-count">{props.item.count}</span>
    </Show>
  </>
);

const NavEntry = (props: { item: NavItem; level?: number }): JSX.Element => (
  <Show when={props.item.items} fallback={<NavPlace item={props.item} level={levelOf(props.item, props.level)} />}>
    {(items) => <NavFold item={props.item} items={items()} level={levelOf(props.item, props.level)} />}
  </Show>
);

const NavPlace = (props: { item: NavItem; level: number }) => (
  <Show when={props.item.menu} fallback={<NavLink item={props.item} level={props.level} />}>
    {(menu) => <NavWithMenu item={props.item} level={props.level} menu={menu()} />}
  </Show>
);

/** An entry with its own deeds: the entry and its "…" side by side, never one inside the other. */
const NavWithMenu = (props: { item: NavItem; level: number; menu: readonly MenuEntry[] }) => {
  const t = useOverlayMessages();
  return (
    <div class="k2-ni-row">
      <NavLink item={props.item} level={props.level} />
      <Menu label={t().actionsFor({ name: props.item.label })} items={props.menu} />
    </div>
  );
};

const NavLink = (props: { item: NavItem; level: number }) => (
  <Dynamic
    component={linkOr(props.item.href, "button")}
    type={props.item.href !== undefined ? undefined : "button"}
    href={props.item.href}
    onNavigate={props.item.href !== undefined ? props.item.onNavigate : undefined}
    onClick={() => props.item.onClick?.()}
    class="k2-ni"
    data-k2-part="Nav.Item"
    aria-current={props.item.current ? "page" : undefined}
    data-level={props.level > 1 ? String(props.level) : undefined}
  >
    <Icon name={props.item.icon ?? "point"} />
    <NavEnd item={props.item} />
  </Dynamic>
);

/** A folding entry: a button that shows or hides its entries below it, one level further in. */
const NavFold = (props: { item: NavItem; items: readonly NavItem[]; level: number }) => {
  const id = createUniqueId();
  const holdsCurrent = () => props.items.some((item) => item.current);
  const [open, setOpen] = createSignal(untrack(holdsCurrent));
  // an entry inside that becomes the open one shows itself
  createComputed(() => {
    if (holdsCurrent()) setOpen(true);
  });
  return (
    <>
      <button
        type="button"
        id={`${id}-fold`}
        class="k2-ni"
        data-k2-part="Nav.Item"
        data-fold=""
        aria-expanded={open() ? "true" : "false"}
        aria-controls={open() ? id : undefined}
        data-holds-current={holdsCurrent() ? "" : undefined}
        data-level={props.level > 1 ? String(props.level) : undefined}
        onClick={() => setOpen(!open())}
      >
        <Icon name={open() ? "chevron-down" : "chevron-right"} />
        <NavEnd item={props.item} />
      </button>
      <Show when={open()}>
        <div class="k2-nav-fold" id={id} role="group" aria-labelledby={`${id}-fold`}>
          <Index each={props.items}>{(item) => <NavEntry item={item()} level={props.level + 1} />}</Index>
        </div>
      </Show>
    </>
  );
};

const groupMenu = (action: NavGroup["action"]) => (action && "items" in action ? action : undefined);
const groupDeed = (action: NavGroup["action"]) => (action && !("items" in action) ? action : undefined);

/** The sidebar of an app: its name, groups of round entries with counts, entries at the foot. */
export const Nav = (props: NavProps) => (
  <nav class="k2-nav" data-k2-part="Nav" aria-label={props.title}>
    <div class="k2-nav-title">
      <Icon name={props.icon} />
      {props.title}
    </div>
    <Index each={props.groups}>
      {(group) => (
        <>
          <Show when={group().label}>
            <div class="k2-nav-label">
              {group().label}
              <Show when={groupMenu(group().action)}>{(menu) => <Menu label={menu().label} items={menu().items} />}</Show>
              <Show when={groupDeed(group().action)}>{(action) => <ActionButton action={action()} variant="ghost" iconOnly />}</Show>
            </div>
          </Show>
          <Index each={group().items}>{(item) => <NavEntry item={item()} />}</Index>
        </>
      )}
    </Index>
    <Show when={props.foot?.length}>
      <div class="k2-nav-foot">
        <Index each={props.foot}>{(item) => <NavEntry item={item()} />}</Index>
      </div>
    </Show>
  </nav>
);

// ── Tabs ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type Tab = {
  /** The name of the view. */
  label: string;
  /** A Tabler icon before the name. */
  icon?: string;
  /** A quiet count after the name. */
  count?: number | string;
  /** The tab leads to this page … */
  href?: string;
  /** … opens it in place on a plain click, while the link still opens in a new tab (see `OnNavigate`) … */
  onNavigate?: OnNavigate;
  /** … or switches the view in place. */
  onClick?: () => void;
  /** The view shown now. */
  current?: boolean;
  /**
   * The tab opens a menu of further views, such as "Weitere +8": the entries of a `Menu` (links with `href` and
   * `onNavigate`, or `onClick`). It is the menu's button and has no address of its own. Its `count` counts these
   * entries; tabs that hide for lack of room join the menu and its count ("+8" with one hidden shows "+9").
   */
  menu?: readonly MenuEntry[];
};

export type TabsProps = {
  /** The tabs in their order; a tab with `menu` stands at the end. */
  items: readonly Tab[];
  /** The name of the tab list, such as "Ansichten", for assistive technology. */
  label: string;
};

/** The words of a tab: its symbol, its name and its count. */
const TabFace = (props: { tab: Tab }) => (
  <>
    <Show when={props.tab.icon}>{(name) => <Icon name={name()} />}</Show>
    <span class="k2-tab-label">{props.tab.label}</span>
    <Show when={props.tab.count !== undefined}>
      <span class="k2-tab-count">{props.tab.count}</span>
    </Show>
  </>
);

/** A tab that hides for lack of room, as an entry of the menu of further views. */
const asEntry = (tab: Tab): MenuEntry => ({
  label: tab.label,
  icon: tab.icon,
  meta: tab.count === undefined ? undefined : String(tab.count),
  href: tab.href,
  onNavigate: tab.href !== undefined ? tab.onNavigate : undefined,
  onClick: tab.onClick,
  checked: tab.current ? true : undefined,
});

/**
 * The count of the menu tab: the app counts its own entries ("+8"); the tabs that hide for lack of room join them,
 * so a count of a number or of "+n" grows by them. Other words stay as the app gives them.
 */
const countWith = (count: Tab["count"], hidden: number): Tab["count"] => {
  if (hidden === 0 || count === undefined) return count;
  if (typeof count === "number") return count + hidden;
  const more = /^\+(\d+)$/.exec(count);
  return more ? `+${Number(more[1]) + hidden}` : count;
};

/**
 * The views of a head or of an object. In the start of a head bar they share it with the actions and give way to
 * them; as the head of a pane they are a bar of their own, 44 px. The open tab stands on the line of its bar. Each
 * tab is a link or a button the Tab key reaches; a tab with `menu` is the button of a menu of further views and
 * stands at the end. A tab is never cut: one that has no room hides whole and is an entry of that menu (without a
 * menu tab a tab "More" opens them), opened from there as its tab opens it, and the menu tab itself always stays whole.
 * Only the open tab never hides (break-ui 25.11.): when it has no room, it takes the place after the tabs that fit,
 * cut with "…" (its whole name on hover), and the tabs between join the menu.
 * Known: while tabs hide, a gap of less than one tab may stand before the menu tab (closing it would move the menu tab
 * after the page loads).
 */
export const Tabs = (props: TabsProps) => {
  const t = useUiMessages();
  const plain = createMemo(() => props.items.filter((tab) => !tab.menu));
  const withMenu = createMemo(() => props.items.filter((tab) => tab.menu));
  // How many plain tabs have room, from the start; the rest wrap below the line of the tabs, where nothing shows.
  // Measured in the browser; the server sends every tab, and the stylesheet already hides what wraps.
  const [fit, setFit] = createSignal(Number.POSITIVE_INFINITY);
  // The open tab, when it would hide: it stands after the tabs that fit, at most this wide.
  const [kept, setKept] = createSignal<{ index: number; room: number }>();
  let row: HTMLDivElement | undefined;
  onMount(() => {
    if (!row) return;
    const measure = () => {
      const tabs = [...(row?.children ?? [])].filter((child): child is HTMLElement => child instanceof HTMLElement);
      if (!row || tabs.length === 0) return;
      // each tab's own width, also of a tab cut now: its name's whole width in place of the cut one
      const widths = tabs.map((tab) => {
        const label = tab.querySelector<HTMLElement>(".k2-tab-label");
        return tab.getBoundingClientRect().width + (label ? label.scrollWidth - label.clientWidth : 0);
      });
      const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
      const room = row.clientWidth;
      const until = (count: number) => widths.slice(0, count).reduce((sum, width, index) => sum + width + (index > 0 ? gap : 0), 0);
      // the first tab always stands in the line (a wrapping line holds at least one), as the server sent it
      let fits = 1;
      while (fits < tabs.length && until(fits + 1) <= room + 0.5) fits += 1;
      const open = plain().findIndex((tab) => tab.current);
      if (open < 0 || open < fits) {
        setKept(undefined);
        setFit(fits >= tabs.length ? Number.POSITIVE_INFINITY : fits);
        return;
      }
      // the open tab keeps at least the room of a short name, or its whole width when that is less
      const least = Math.min(widths[open]!, 96);
      let before = Math.min(fits, open);
      while (before > 0 && until(before) + gap + least > room + 0.5) before -= 1;
      const left = Math.floor(room - until(before) - (before > 0 ? gap : 0));
      // without room even for a short name the open tab hides like the others (a cut to nothing says nothing)
      if (left < least) {
        setKept(undefined);
        setFit(fits);
        return;
      }
      setFit(before);
      setKept({ index: open, room: left });
    };
    // What the measurement changes (the count of the menu tab, "+8" to "+12") can change the room of the tabs again.
    // So it runs in the next frame, once per frame, never inside the observer's own turn (WebKit reports that as a
    // resize loop); the next frame measures what it changed.
    let frame = 0;
    const later = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    measure();
    const sizes = new ResizeObserver(later);
    sizes.observe(row);
    const watchAll = () => {
      for (const child of row?.children ?? []) sizes.observe(child);
    };
    const parts = new MutationObserver(() => {
      watchAll();
      later();
    });
    watchAll();
    parts.observe(row, { childList: true });
    onCleanup(() => {
      cancelAnimationFrame(frame);
      sizes.disconnect();
      parts.disconnect();
    });
  });
  const isKept = (index: number) => kept()?.index === index;
  const hidden = () => plain().filter((_, index) => index >= fit() && !isKept(index));
  const more = () => hidden().map(asEntry);
  return (
    <nav class="k2-tabs-nav" data-k2-part="Tabs" aria-label={props.label}>
      <div class="k2-tabs" ref={row}>
        <Index each={plain()}>
          {(tab, index) => (
            <Dynamic
              component={linkOr(tab().href, "button")}
              type={tab().href !== undefined ? undefined : "button"}
              class="k2-tab"
              href={tab().href}
              onNavigate={tab().href !== undefined ? tab().onNavigate : undefined}
              onClick={() => tab().onClick?.()}
              aria-current={tab().current ? "page" : undefined}
              data-overflow={index >= fit() && !isKept(index) ? "" : undefined}
              data-kept={isKept(index) ? "" : undefined}
              title={isKept(index) ? tab().label : undefined}
              style={isKept(index) ? custom({ "--k2-tab-room": `${kept()?.room ?? 0}px` }) : undefined}
            >
              <TabFace tab={tab()} />
            </Dynamic>
          )}
        </Index>
      </div>
      <Index each={withMenu()}>
        {(tab, index) => (
          <MenuTab
            items={
              index === withMenu().length - 1 && more().length > 0 ? [...more(), "separator", ...(tab().menu ?? [])] : (tab().menu ?? [])
            }
            current={tab().current}
          >
            <TabFace tab={index === withMenu().length - 1 ? { ...tab(), count: countWith(tab().count, more().length) } : tab()} />
          </MenuTab>
        )}
      </Index>
      <Show when={withMenu().length === 0 && more().length > 0}>
        <MenuTab items={more()} current={hidden().some((tab) => tab.current)}>
          <TabFace tab={{ label: t().more, count: `+${more().length}` }} />
        </MenuTab>
      </Show>
    </nav>
  );
};

// ── Path ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Where a page stands, in the start of its head instead of tabs: the places before it quiet, the page itself in 600.
 * On the phone the path gives way to the phone bar of the shell, which names the page; its head stays only for a search.
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
export type StatusFact = {
  /** Words before the value, such as "Summe". */
  before?: string;
  /** The value itself, in 600; a number is written in the language of the page (12.847). */
  value?: string | number;
  /** Words after the value, such as "überfällig". */
  after?: string;
};

export type StatusRowProps = {
  /** The one main statement, such as "7 unread". */
  lead: string;
  /**
   * The results refresh in place, such as after a filter changed: `true` shows a quiet turning mark after the lead
   * while the old entries stay, and assistive technology hears "Wird geladen…". Pass `false` while nothing loads, so
   * the mark's place of 16 px stays and nothing moves when it comes and goes; leave it out where the row never
   * refreshes.
   */
  loading?: boolean;
  /**
   * Key figures after the lead. They give way only where they do not fit before the filters, the later ones first and
   * whole, so the filters keep their words and no figure runs under them; without filters they keep the row's room.
   * On the phone they go. Put what must stay in `lead`.
   */
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

/** The status row of a pane (52 px): the one lead statement, its loading mark, key figures, filters on the right. */
export const StatusRow = (props: StatusRowProps) => {
  const t = useUiMessages();
  const locale = useLocale();
  // a count is said in the reader's language: 12.847 in German, 12,847 in English
  const said = (value: string | number) => (typeof value === "number" ? value.toLocaleString(locale()) : value);
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
              {/* the place of the loading mark is there while the row can refresh, so the mark moves nothing */}
              <Show when={props.loading !== undefined}>
                <span class="k2-status-busy" role="status">
                  <Show when={props.loading}>
                    <Icon name="loader-2" />
                    <span class="k2-hidden-text">{t().loading}</span>
                  </Show>
                </span>
              </Show>
              <Show when={props.facts?.length}>
                <span class="k2-status-facts">
                  <For each={props.facts}>
                    {(fact) => (
                      <span class="k2-fact">
                        {fact.before ?? ""}
                        {fact.before && fact.value !== undefined ? " " : ""}
                        <Show when={fact.value !== undefined}>
                          <b>{said(fact.value!)}</b>
                        </Show>
                        {fact.after ? ` ${fact.after}` : ""}
                      </span>
                    )}
                  </For>
                </span>
              </Show>
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
            {/* in a narrow column the actions keep only their symbols, the way out its ×; the words stay their names */}
            <For each={selection().actions}>{(action) => <ActionButton action={action} titled />}</For>
            <ActionButton action={{ icon: "x", ...selection().clear }} variant="text" titled />
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
  /** The sentence and its consequence: what is the matter, and what follows from it. */
  children: JSX.Element;
};

const toneIcon = { note: "note", ai: "sparkles", bad: "alert-circle", warn: "alert-triangle" } as const;

/** The tones whose long text shows its first lines and "Show more" (the stylesheet: a summary 4, a note 8). */
const clampedTones: ReadonlySet<NoticeProps["tone"]> = new Set(["ai", "note"]);

/**
 * A band with a sign, a sentence and its consequence, and at most two deeds. The tint is its edge. A person's note
 * and an AI summary keep their line breaks; a long one shows its first lines (a summary 4, a note 8) and "Show more"
 * over the end of the last one, so nothing moves when the page comes alive.
 */
export const Notice = (props: NoticeProps) => {
  const t = useUiMessages();
  const clamped = () => clampedTones.has(props.tone);
  const [long, setLong] = createSignal(false);
  const [open, setOpen] = createSignal(false);
  let text: HTMLSpanElement | undefined;
  onMount(() => {
    if (!text || !clamped() || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      if (text && !open()) setLong(text.scrollHeight > text.clientHeight + 1);
    };
    const sizes = new ResizeObserver(measure);
    sizes.observe(text);
    measure();
    onCleanup(() => sizes.disconnect());
  });
  return (
    <div
      class="k2-notice"
      data-k2-part="Notice"
      data-tone={props.tone}
      data-title={props.title ? "" : undefined}
      data-open={open() ? "" : undefined}
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
      <span class="k2-notice-text" ref={text}>
        {props.children}
      </span>
      <Show when={long()}>
        <button type="button" class="k2-notice-more" aria-expanded={open() ? "true" : "false"} onClick={() => setOpen(!open())}>
          {open() ? t().showLess : t().showMore}
        </button>
      </Show>
      <Show when={props.actions?.length}>
        <span class="k2-notice-end">
          <For each={props.actions}>{(action) => <ActionButton action={action} variant="text" />}</For>
        </span>
      </Show>
    </div>
  );
};

// ── Digest ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type DigestEntry = {
  /** A Tabler icon for the kind of thing. */
  icon: string;
  /** The data colour of its area. */
  color?: string;
  /** A short date, such as "17. Nov.". */
  date: string;
  /** The number or name of the thing. */
  title: string;
  /** Its state: a symbol and a word. */
  state: { icon: string; label: string; tone?: Status };
  /** One sentence about it; `<Text weight="strong">` stresses a word. */
  text: JSX.Element;
  /** The page of the thing: its number becomes a link. */
  href?: string;
};

export type DigestProps =
  | {
      /** The dated entries, newest first. */
      items: readonly DigestEntry[];
      children?: never;
      /** The name of the list, for assistive technology. */
      label?: string;
    }
  | {
      items?: never;
      /** Plain `Row`s whose second line is a sentence, instead of dated entries. */
      children: JSX.Element;
      /** The name of the list, for assistive technology. */
      label?: string;
    };

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
  /** The name of the step, such as "Angekommen". */
  label: string;
  /** A quiet line under the step, such as a date or "10 von 18". */
  meta?: string;
  /** Done (grey with a tick), the one running now (a blue ring), or still to come (empty). */
  state: "done" | "now" | "next";
};

/** A way of a few steps: done ones grey with a tick, the running one a blue ring, the coming ones empty. */
export type StepsProps = {
  /** The steps in their order. */
  items: readonly Step[];
  /** The name of the way, such as "Weg der Einlieferung", for assistive technology. */
  label: string;
};

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

export type RecordId = {
  /** A quiet word before the value, such as "Kunde". */
  label?: string;
  /** The identifier itself. */
  value: string;
  /** A Tabler icon instead of the label, such as `phone`. */
  icon?: string;
  /** Offers a copy button for the value. */
  copy?: boolean;
};

export type RecordHeadProps = {
  /** The name of the record, the page's heading. */
  name: string;
  /** The picture or initials before the name. */
  avatar?: Person;
  /** Kinds of the record, such as "Private". */
  kinds?: readonly string[];
  /**
   * Identifiers and contact at a glance. They give way when the head has no room (cut, then out of sight; always on
   * the phone), before the name is cut with "…"; the head's actions keep their place.
   */
  ids?: readonly RecordId[];
};

/** The identity of a record in its head: avatar, name, kinds, identifiers. Put it in the start of the head `Bar`. */
export const RecordHead = (props: RecordHeadProps) => (
  <>
    <Show when={props.avatar}>{(person) => <Avatar {...person()} decorative />}</Show>
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
