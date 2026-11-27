import { createEffect, createMemo, createSignal, For, type JSX, onCleanup, children as resolveChildren, Show, untrack } from "solid-js";
import { type MenuLevelParts, useMenuLevels } from "./behavior/menu";
import { usePopover } from "./behavior/overlays";
import { Icon } from "./marks";
import { useOverlayMessages } from "./overlay-messages";
import { usePhone } from "./overlays";
import { PageLayer } from "./page-layer";
import type { OnNavigate } from "./types";

/**
 * One entry of a menu, as data. `onClick` runs it; a Promise keeps the menu open and the entry busy until it settles.
 * `href` makes it a link. `checked` makes it an entry that toggles (the tick stands at its end, like in a selection).
 * `items` opens a submenu to the side, `panel` a panel such as a calendar. `danger` is red and stands after a line.
 */
export type MenuItem = {
  /** The words of the entry. */
  label: string;
  /** A Tabler icon name without the `ti-` prefix. */
  icon?: string;
  /** The deed; a returned Promise keeps the menu open and the entry busy until it settles. */
  onClick?: () => unknown;
  /** The page the entry opens, as a link. */
  href?: string;
  /** With `href`: opens the page in place on a plain click or Enter, as a tab or a row does (see `OnNavigate`). */
  onNavigate?: OnNavigate;
  /** Red, for a deed that destroys; the menu puts a line before the first one. */
  danger?: boolean;
  /** The entry cannot be chosen now: dimmed, and focus passes over it. */
  disabled?: boolean;
  /** A quiet hint at the end, such as the key that does the same ("⌘ D"). */
  meta?: string;
  /**
   * The value set now through this entry's submenu or panel, such as the time a reminder is due: it stands at the end
   * in the app's colour, as a filter shows a bound that is set, and is part of the entry's name. It takes the place
   * of `meta`, which does not show beside it.
   */
  current?: string;
  /** An entry that toggles: `onClick` flips it. */
  checked?: boolean;
  /** A submenu, opened to the side. */
  items?: readonly MenuEntry[];
  /**
   * In place of `items`: a panel, such as a `DatePicker`, opened as the next step: it takes the place of the menu the
   * entry stands in (on the phone a sheet of its own) under a head that leads back, and Escape leads back too. Its keys
   * stay its own (the arrows walk a calendar, not the menu); `close` closes the menu once the panel has picked.
   */
  panel?: (close: () => void) => JSX.Element;
  /** In a section with `choice`: what choosing this entry gives; its `label` by default. */
  value?: string;
};

/**
 * Entries under a heading, such as "Antwortart". With `choice` the section is one choice: its entries are options,
 * the one whose `value` (or `label`) is `choice` carries the tick, and choosing one closes the menu and calls
 * `onChoose` with its value; choosing the ticked one only closes it. The menu draws a line between a section and what
 * stands around it.
 */
export type MenuSection = {
  /**
   * The quiet heading over the entries, such as "Sortieren nach". "" leaves it out, for a choice whose entries say
   * enough by themselves (offered times, with the one set now ticked).
   */
  title: string;
  /** The entries under the heading. */
  items: readonly MenuItem[];
  /** Makes the section one choice: the value of the chosen entry, which carries the tick. */
  choice?: string;
  /** Called with the value of the entry chosen in a section with `choice`; choosing closes the menu. */
  onChoose?: (value: string) => void;
};

/** An entry, a section of entries under a heading, or a line between groups of entries. */
export type MenuEntry = MenuItem | MenuSection | "separator";

const isSection = (entry: MenuEntry): entry is MenuSection => entry !== "separator" && "title" in entry;

type Variant = "primary" | "secondary" | "ghost" | "text";

/** How a menu's or popover's button looks: the same props as `Button`. */
export type TriggerProps = {
  /** `ghost` by default for a symbol alone, framed (`secondary`) with words. */
  variant?: Variant;
  /** A Tabler icon name; a button without words shows `dots`. */
  icon?: string;
  /** The button cannot open now: dimmed, and pressed no time. */
  disabled?: boolean;
} & (
  | {
      /** The words on the button; a chevron follows them. */
      children: JSX.Element;
      /** Another name for assistive technology, only where the words alone do not say enough. */
      label?: string;
    }
  | {
      children?: undefined;
      /** The name of the button without words; it shows as a hint. Defaults to "More actions". */
      label?: string;
    }
);

export type MenuProps = TriggerProps & {
  /** The entries: items, sections under a heading, and `"separator"` between groups. */
  items: readonly MenuEntry[];
};

/**
 * Internal to @k2b/ui: the button is a shortcut for the pointer only, from the first markup on: no Tab stop, hidden
 * from assistive technology, such as the "…" on a place of a tree or a tile of a grid that is one Tab stop. Only
 * together with `Menu.Context` on the thing (a right-click and a long press, also with VoiceOver on a phone), an own
 * Shift+F10 binding named in the thing's `aria-keyshortcuts`, and the hint of the thing (`aria-description`). That is
 * why no app gets it: `PointerMenu` is used where those three stand.
 */
type MenuRootProps = MenuProps & { pointerOnly?: boolean };

/**
 * Lines between groups: before the first dangerous entry after others, and around a section; no line at the start,
 * the end or twice.
 */
export const menuEntries = (entries: readonly MenuEntry[]): MenuEntry[] => {
  const out: MenuEntry[] = [];
  const danger = (entry: MenuEntry) => entry !== "separator" && !isSection(entry) && !!entry.danger;
  for (const entry of entries) {
    const last = out.at(-1);
    const apart = last !== undefined && last !== "separator" && entry !== "separator";
    if (apart && (isSection(entry) || isSection(last) || (danger(entry) && !danger(last)))) out.push("separator");
    if (entry === "separator" && (last === undefined || last === "separator")) continue;
    out.push(entry);
  }
  if (out.at(-1) === "separator") out.pop();
  return out;
};

/** The inside of a menu's or popover's button, as `Button` draws it. */
export const TriggerFace = (props: { icon?: string; label: JSX.Element; iconOnly: boolean; chevron: boolean }) => (
  <>
    <Show when={props.icon}>{(name) => <Icon name={name()} />}</Show>
    <Show when={!props.iconOnly}>
      <span class="k2-btn-label">{props.label}</span>
    </Show>
    <Show when={props.chevron}>
      <Icon name="chevron-down" />
    </Show>
  </>
);

/** Where a popup lines up with its button: under its start, or under its end when the button sits on the right. */
export const alignTo = (element: HTMLElement | undefined): "start" | "end" => {
  if (!element) return "start";
  const box = element.getBoundingClientRect();
  return box.left + box.width / 2 > document.documentElement.clientWidth / 2 ? "end" : "start";
};

/** The room a menu, a submenu or a panel keeps from the edges of the window, in px. */
const edgeRoom = 8;

/** Whether any entry, also one in a section, has a symbol: then every entry keeps its place, so the words line up. */
const hasLead = (entries: readonly MenuEntry[]): boolean =>
  entries.some((entry) => entry !== "separator" && (isSection(entry) ? hasLead(entry.items) : !!entry.icon));

const Entries = (props: { level: MenuLevelParts; entries: readonly MenuEntry[]; lead?: boolean }) => {
  const lead = () => props.lead ?? hasLead(props.entries);
  // Keyed by kind and words, not by object or place: new data for an open menu (a tick that flipped, an entry that
  // came in before it) keeps every entry's element, so the highlight and the focus stay. An entry that turns into
  // another kind gets a new key and is made anew, with the right role and handler.
  const keyed = createMemo(() => {
    const seen = new Map<string, number>();
    return menuEntries(props.entries).map((entry, index) => {
      const base =
        entry === "separator"
          ? `separator:${index}`
          : isSection(entry)
            ? `${entry.choice === undefined ? "section" : "choice"}:${entry.title}`
            : `${kindOf(entry)}:${entry.label}`;
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      return { key: count ? `${base}#${count}` : base, entry };
    });
  });
  return (
    <For each={keyed().map((each) => each.key)}>
      {(key) => {
        const entry = () => keyed().find((each) => each.key === key)?.entry ?? "separator";
        const first = untrack(entry);
        if (first === "separator") return <props.level.Separator class="k2-msep" />;
        if (isSection(first)) {
          const section = () => {
            const now = entry();
            return now !== "separator" && isSection(now) ? now : first;
          };
          return <Section level={props.level} section={section()} name={key} lead={lead()} />;
        }
        return <Entry level={props.level} kind={kindOf(first)} item={itemOf(entry())} value={key} lead={lead()} />;
      }}
    </For>
  );
};

/**
 * A section: its heading names the group for assistive technology too. A choice is a radio group of core: arrows walk
 * it, the chosen one is `aria-checked`, choosing closes the menu.
 */
const Section = (props: { level: MenuLevelParts; section: MenuSection; name: string; lead: boolean }) => {
  // Core names a group by its heading once the heading is on the page. Its radio group listens to its value only and
  // misses that moment, so the heading's id is handed to it here, once the heading is there.
  const [headingId, setHeadingId] = createSignal<string>();
  const heading = (
    <Show when={props.section.title}>
      {(title) => (
        <props.level.GroupLabel
          group={props.name}
          class="k2-mh"
          ref={(element: HTMLElement) => queueMicrotask(() => setHeadingId(element.id))}
        >
          {title()}
        </props.level.GroupLabel>
      )}
    </Show>
  );
  if (untrack(() => props.section.choice) === undefined) {
    return (
      <props.level.Group id={props.name} class="k2-mgroup">
        {heading}
        <Entries level={props.level} entries={props.section.items} lead={props.lead} />
      </props.level.Group>
    );
  }
  const valueOf = (item: MenuItem) => item.value ?? item.label;
  return (
    <props.level.RadioGroup
      name={props.name}
      value={props.section.choice}
      onValueChange={(value: string) => props.section.onChoose?.(value)}
      aria-labelledby={headingId()}
      class="k2-mgroup"
    >
      {heading}
      <For each={props.section.items.map(valueOf)}>
        {(value) => {
          const item = () => props.section.items.find((each) => valueOf(each) === value) ?? { label: value };
          return (
            <props.level.RadioItem
              group={props.name}
              value={value}
              label={item().label}
              disabled={item().disabled}
              closeOnSelect
              class="k2-mi"
            >
              <EntryFace
                item={item()}
                lead={props.lead}
                end={
                  <span class="k2-mi-tick">
                    <Show when={props.section.choice === value}>
                      <Icon name="check" />
                    </Show>
                  </span>
                }
              />
            </props.level.RadioItem>
          );
        }}
      </For>
    </props.level.RadioGroup>
  );
};

type EntryKind = "submenu" | "panel" | "tick" | "link" | "deed";

const kindOf = (entry: MenuItem): EntryKind =>
  entry.panel
    ? "panel"
    : entry.items
      ? "submenu"
      : entry.checked !== undefined
        ? "tick"
        : entry.href !== undefined && !entry.disabled
          ? "link"
          : "deed";

const itemOf = (entry: MenuEntry): MenuItem => (entry === "separator" || isSection(entry) ? { label: "" } : entry);

const EntryFace = (props: { item: MenuItem; lead: boolean; end?: JSX.Element }) => (
  <>
    <Show when={props.lead}>
      <span class="k2-mi-lead">
        <Show when={props.item.icon}>{(name) => <Icon name={name()} />}</Show>
      </span>
    </Show>
    <span class="k2-mi-label">{props.item.label}</span>
    <Show when={props.item.current ?? props.item.meta}>
      {(meta) => (
        <span class="k2-mi-meta" data-set={props.item.current ? "" : undefined}>
          {meta()}
        </span>
      )}
    </Show>
    {props.end}
  </>
);

/**
 * An entry that opens a panel (a calendar) as the next step: a menu item, so the menu's keys reach it, that is also
 * the trigger of its own popover. The popover is a dialog of its own at the end of the page, a layer over the menu:
 * the menu never sees its keys (the arrows stay with the calendar), a press inside it is no press outside the menu.
 * On a wide screen it takes the place of the menu the entry stands in (at most two layers show); on the phone it is a
 * sheet of its own. Its head, Escape and the back button lead back to the entry. Enter, Space and the arrow to the side
 * open it, as they open a submenu; it stays open while the menu's data changes (a clock that moved on keeps what was
 * typed in it).
 */
const PanelEntry = (props: { level: MenuLevelParts; item: MenuItem; keyed: Record<string, unknown>; lead: boolean }) => {
  const t = useOverlayMessages();
  const phone = usePhone();
  const [open, setOpenState] = createSignal(false);
  const [entry, setEntry] = createSignal<HTMLElement>();
  // Where the panel stands on a wide screen: on the corner of its menu that the menu grew from, taken once when it
  // opens (before the menu gives way). It grows the way the menu grew: to the left for a submenu that opened to the
  // left or a menu at the right edge of its button (the end in left-to-right, the start in right-to-left), to the right
  // for every other one, also a context menu at the pointer or a menu turned upwards.
  const [place, setPlace] = createSignal<{ x: number; top: number; growLeft: boolean; rtl: boolean }>();
  // Closing gives the menu its place back at once, before the focus returns to the entry in it (a hidden entry takes
  // no focus); the focus then stands on the entry unless something else took it.
  const setOpen = (next: boolean) => {
    if (next && !open()) {
      const menu = entry()?.closest<HTMLElement>(".k2-menu");
      if (menu) {
        const box = menu.getBoundingClientRect();
        const side = menu.getAttribute("data-side");
        // the menu and the panel's layer at the end of the page both take the page's direction (<html dir>), so the
        // menu's says how core reads the panel's start and end too
        const rtl = getComputedStyle(menu).direction === "rtl";
        // a submenu's side is physical; a menu under or over its button lines up with its start or end, which the
        // page's direction turns into left or right
        const growLeft = side === "left" || (side !== "right" && (menu.getAttribute("data-align") === "end") !== rtl);
        setPlace({ x: growLeft ? box.right : box.left, top: box.top, growLeft, rtl });
      } else setPlace(undefined);
    }
    if (!next && open()) {
      entry()?.closest(".k2-menu")?.removeAttribute("data-covered");
      requestAnimationFrame(() => {
        const at = document.activeElement;
        if (!at || at === document.body) entry()?.focus();
      });
    }
    setOpenState(next);
  };
  const popover = usePopover(() => ({ open: open(), onOpenChange: setOpen, modal: true, presentation: phone() ? "sheet" : "popover" }));
  createEffect(() => {
    const element = entry();
    if (!element) return;
    // a disabled entry stays shut, to a press and to the keys
    const disabled = !!props.item.disabled;
    onCleanup(popover.bindTrigger(element, { disabled }));
    // the menu's Enter would choose the entry and its arrow to the side does nothing here: both open the panel
    const keys = (event: KeyboardEvent) => {
      if (disabled || (event.key !== "Enter" && event.key !== " " && event.key !== "ArrowRight")) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(true);
    };
    element.addEventListener("keydown", keys);
    onCleanup(() => element.removeEventListener("keydown", keys));
  });
  // The panel takes the focus once it shows (a sheet shows a moment after it opens, and WebKit leaves the focus of a
  // tap in the menu): keys, Escape first of all, then reach the panel, not the menu behind it.
  let panel: HTMLElement | undefined;
  createEffect(() => {
    if (!open()) return;
    let frame = 0;
    let tries = 0;
    const take = () => {
      const shown = panel?.isConnected && !panel.hidden && panel.getClientRects().length > 0;
      if (!shown) {
        tries += 1;
        if (tries < 120) frame = requestAnimationFrame(take);
        return;
      }
      if (panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
    };
    frame = requestAnimationFrame(take);
    // An Escape that still lands in the menu behind (the menu's sheet keeps the focus in WebKit) closes the panel
    // only, as the innermost layer, and puts the focus back on its entry. Only that menu: a menu inside the panel is a
    // layer above it and closes by itself.
    const escape = (event: KeyboardEvent) => {
      const behind = entry()?.closest('[role="menu"]');
      if (event.key !== "Escape" || !behind || document.activeElement?.closest('[role="menu"]') !== behind) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setOpen(false);
      entry()?.focus();
    };
    document.addEventListener("keydown", escape, true);
    onCleanup(() => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", escape, true);
    });
  });
  // On a wide screen the panel takes the place of the menu its entry stands in (at most two layers show): that menu
  // gives way while the panel is open, and the panel stands where it stood. The panel's head leads back to it.
  const holder = () => entry()?.closest<HTMLElement>(".k2-menu") ?? undefined;
  createEffect(() => {
    const menu = holder();
    if (!open() || phone() || !menu) return;
    menu.setAttribute("data-covered", "");
    onCleanup(() => menu.removeAttribute("data-covered"));
  });
  const corner = () => (phone() ? undefined : place());
  /** The edge of the panel that stands on the corner, in the reading direction that core places by. */
  const panelAlign = () => {
    const at = corner();
    return at && at.growLeft !== at.rtl ? "end" : "start";
  };
  const close = () => {
    setOpen(false);
    props.level.close();
  };
  return (
    <>
      <props.level.Item {...props.keyed} ref={setEntry} closeOnSelect={false}>
        <EntryFace item={props.item} lead={props.lead} end={<Icon name="chevron-right" />} />
      </props.level.Item>
      <PageLayer from={entry}>
        <popover.Popup
          ref={(element: HTMLElement) => {
            panel = element;
          }}
          class="k2-pop k2-dpop"
          data-k2-part="Popover"
          aria-label={props.item.label}
          {...(() => {
            const at = corner();
            if (!at) return {};
            // The corner is taken once, when the panel opens. Read on every check, its height keeps the panel inside
            // the window: in a short one it moves up, never past the top (taller than the window, it scrolls inside).
            const anchor = {
              getBoundingClientRect: () => {
                const tall = panel?.offsetHeight ?? 0;
                return new DOMRect(at.x, Math.max(edgeRoom, Math.min(at.top, window.innerHeight - tall - edgeRoom)), 0, 0);
              },
            };
            return { anchor };
          })()}
          side="bottom"
          // the edge of the panel that stands on the corner, in the reading direction core places by
          align={panelAlign()}
          sideOffset={corner() ? 0 : 4}
          collisionPadding={edgeRoom}
        >
          {/* the panel names its step and leads back to the entries it took the place of, as a submenu's step does */}
          <button
            type="button"
            class="k2-mi k2-panel-back"
            aria-label={t().backTo({ name: props.item.label })}
            onClick={() => {
              setOpen(false);
              entry()?.focus();
            }}
          >
            <Icon name="chevron-left" />
            <span class="k2-mi-label">{props.item.label}</span>
          </button>
          {/* made once while open: new data for the menu keeps what was typed in the panel */}
          {untrack(() => props.item.panel?.(close))}
        </popover.Popup>
      </PageLayer>
    </>
  );
};

/** One entry of one kind (submenu, tick, link, deed); its words and states follow the data. */
const Entry = (props: { level: MenuLevelParts; kind: EntryKind; item: MenuItem; value: string; lead: boolean }) => {
  const shared = {
    class: "k2-mi",
    get "data-danger"() {
      return props.item.danger ? "" : undefined;
    },
    get disabled() {
      return props.item.disabled;
    },
  };
  const keyed = {
    ...shared,
    value: props.value,
    get label() {
      return props.item.label;
    },
  };
  const kind = props.kind;
  if (kind === "submenu") {
    const sub = props.level.useSubmenu();
    let trigger: HTMLElement | undefined;
    // a submenu of a submenu that opened to the left goes on to the left, so it never covers the way it came
    const side = () => (trigger?.closest(".k2-menu")?.getAttribute("data-side") === "left" ? "left" : undefined);
    return (
      <>
        <sub.Trigger
          {...shared}
          ref={(element: HTMLElement) => {
            trigger = element;
          }}
        >
          <EntryFace item={props.item} lead={props.lead} end={<Icon name="chevron-right" />} />
        </sub.Trigger>
        <sub.Popup class="k2-menu" data-k2-part="Menu" side={side()} sideOffset={4} collisionPadding={edgeRoom}>
          <Entries level={sub} entries={props.item.items ?? []} />
        </sub.Popup>
      </>
    );
  }
  if (kind === "panel") return <PanelEntry level={props.level} item={props.item} keyed={keyed} lead={props.lead} />;
  if (kind === "tick") {
    return (
      <props.level.CheckboxItem {...keyed} checked={props.item.checked ?? false} onCheckedChange={() => props.item.onClick?.()}>
        <EntryFace
          item={props.item}
          lead={props.lead}
          end={
            <span class="k2-mi-tick">
              <Show when={props.item.checked}>
                <Icon name="check" />
              </Show>
            </span>
          }
        />
      </props.level.CheckboxItem>
    );
  }
  if (kind === "link") {
    return (
      <Show
        when={props.item.onNavigate}
        fallback={
          <props.level.LinkItem {...keyed} href={props.item.href}>
            <EntryFace item={props.item} lead={props.lead} />
          </props.level.LinkItem>
        }
      >
        {(onNavigate) => (
          <props.level.NavLinkItem {...keyed} href={props.item.href} onNavigate={onNavigate()}>
            <EntryFace item={props.item} lead={props.lead} />
          </props.level.NavLinkItem>
        )}
      </Show>
    );
  }
  return (
    <props.level.Item {...keyed} onSelect={() => props.item.onClick?.()}>
      <EntryFace item={props.item} lead={props.lead} />
    </props.level.Item>
  );
};

/**
 * A menu behind a button: entries of 32 px, 4 px inside a floating surface of 8 px radius, lines only between
 * groups, dangerous deeds red after a line, submenus to the side. Without words the button is the quiet "…" of a
 * head or a section; with words it is a framed button with a chevron. Keys, typeahead, focus and placement come from
 * the behaviour layer; the menu lines up with the end of a button on the right and the start of one on the left.
 */
const MenuRoot = (props: MenuRootProps) => {
  const t = useOverlayMessages();
  const words = resolveChildren(() => props.children);
  const iconOnly = () => words() === undefined;
  const name = () => props.label ?? t().moreActions;
  let trigger: HTMLElement | undefined;
  const [align, setAlign] = createSignal<"start" | "end">("end");
  const phone = usePhone();
  const level = useMenuLevels(() => ({
    presentation: phone() ? "sheet" : "popover",
    onOpenChange: (open: boolean) => {
      if (open) setAlign(alignTo(trigger));
    },
  }));
  return (
    <>
      <level.Trigger
        ref={(element: HTMLElement) => {
          trigger = element;
        }}
        disabled={props.disabled}
        class="k2-btn"
        data-k2-part="Button"
        data-variant={(props.variant ?? (iconOnly() ? "ghost" : "secondary")) === "secondary" ? undefined : (props.variant ?? "ghost")}
        data-icon-only={iconOnly() ? "" : undefined}
        data-menu={iconOnly() ? undefined : ""}
        // the "…" of a head stays on the phone, where the other buttons give way, so their deeds stay reachable
        data-keep={iconOnly() ? "" : undefined}
        aria-label={iconOnly() ? name() : undefined}
        title={iconOnly() ? name() : undefined}
        tabindex={props.pointerOnly ? -1 : undefined}
        aria-hidden={props.pointerOnly ? "true" : undefined}
      >
        <TriggerFace icon={props.icon ?? (iconOnly() ? "dots" : undefined)} label={words()} iconOnly={iconOnly()} chevron={!iconOnly()} />
      </level.Trigger>
      <level.Popup class="k2-menu" data-k2-part="Menu" side="bottom" align={align()} sideOffset={4} collisionPadding={edgeRoom}>
        <Entries level={level} entries={props.items} />
      </level.Popup>
    </>
  );
};

/**
 * A tab that opens a menu of further views (internal to `Tabs`): it looks like a tab, with the chevron after its
 * words, and is the menu's button, so Enter, Space and the arrow down open it and Escape brings the focus back.
 */
export const MenuTab = (props: { items: readonly MenuEntry[]; current?: boolean; children: JSX.Element }) => {
  let trigger: HTMLElement | undefined;
  const [align, setAlign] = createSignal<"start" | "end">("start");
  const phone = usePhone();
  const level = useMenuLevels(() => ({
    presentation: phone() ? "sheet" : "popover",
    onOpenChange: (open: boolean) => {
      if (open) setAlign(alignTo(trigger));
    },
  }));
  return (
    <>
      <level.Trigger
        ref={(element: HTMLElement) => {
          trigger = element;
        }}
        class="k2-tab"
        data-menu=""
        aria-current={props.current ? "page" : undefined}
      >
        {props.children}
        <Icon name="chevron-down" />
      </level.Trigger>
      <level.Popup class="k2-menu" data-k2-part="Menu" side="bottom" align={align()} sideOffset={4} collisionPadding={edgeRoom}>
        <Entries level={level} entries={props.items} />
      </level.Popup>
    </>
  );
};

export type MenuContextProps = {
  /** The entries, the same as those of the "…" beside the element. */
  items: readonly MenuEntry[];
  /** The one element the menu belongs to, such as a `Row`; it gets no wrapper. */
  children: JSX.Element;
  /** No menu opens on a right-click or a long press; the browser's own menu shows instead. */
  disabled?: boolean;
};

/**
 * The same menu on a thing itself: a right-click or a long press opens it at the pointer, Shift+F10 or the context
 * menu key at the thing. The thing keeps its own element; nothing wraps it.
 */
const MenuContext = (props: MenuContextProps) => {
  const level = useMenuLevels();
  const resolved = resolveChildren(() => props.children);
  const element = () => resolved.toArray().find((node): node is HTMLElement => node instanceof HTMLElement);
  createEffect(() => {
    const area = element();
    if (!area || props.disabled) return;
    onCleanup(level.bindContext(area));
  });
  // The menu stands at the end of the page, not beside the thing: a role="menu" inside a list is no list item, and
  // a sibling after a row would end the list's last-row rules while the menu is open.
  return (
    <>
      {resolved()}
      <PageLayer from={element}>
        <level.Popup class="k2-menu" data-k2-part="Menu" collisionPadding={edgeRoom}>
          <Entries level={level} entries={props.items} />
        </level.Popup>
      </PageLayer>
    </>
  );
};

/** A menu behind a button, or with `Menu.Context` on a thing itself. */
const PublicMenu: (props: MenuProps) => JSX.Element = (props) => <MenuRoot {...props} />;
export const Menu = Object.assign(PublicMenu, { Context: MenuContext });

/** The "…" of a tree place or a media tile (internal, see `MenuRootProps`). */
export const PointerMenu = (props: MenuProps) => <MenuRoot {...props} pointerOnly />;
