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
  label: string;
  /** A Tabler icon name without the `ti-` prefix. */
  icon?: string;
  onClick?: () => unknown;
  href?: string;
  /** With `href`: opens the page in place on a plain click or Enter, as a tab or a row does (see `OnNavigate`). */
  onNavigate?: OnNavigate;
  /** Red, for a deed that destroys; the menu puts a line before the first one. */
  danger?: boolean;
  disabled?: boolean;
  /** A quiet hint at the end, such as the key that does the same ("⌘ D"). */
  meta?: string;
  /** An entry that toggles: `onClick` flips it. */
  checked?: boolean;
  /** A submenu, opened to the side. */
  items?: readonly MenuEntry[];
  /**
   * In place of `items`: a panel opened to the side like a submenu, such as a `DatePicker`; on the phone the sheet's
   * next step. Its keys stay its own (only Escape goes back); `close` closes the menu once the panel has picked.
   */
  panel?: (close: () => void) => JSX.Element;
  /** In a section with `choice`: what choosing this entry gives; its `label` by default. */
  value?: string;
};

/**
 * Entries under a heading, such as "Antwortart". With `choice` the section is one choice: its entries are options,
 * the one whose `value` (or `label`) is `choice` carries the tick, and choosing one closes the menu and calls
 * `onChoose` with its value. The menu draws a line between a section and what stands around it.
 */
export type MenuSection = {
  title: string;
  items: readonly MenuItem[];
  choice?: string;
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
  disabled?: boolean;
} & (
  | {
      /** The words on the button; a chevron follows them. */
      children: JSX.Element;
      label?: string;
    }
  | {
      children?: undefined;
      /** The name of the button without words; it shows as a hint. Defaults to "More actions". */
      label?: string;
    }
);

export type MenuProps = TriggerProps & { items: readonly MenuEntry[] };

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
    <props.level.GroupLabel group={props.name} class="k2-mh" ref={(element: HTMLElement) => queueMicrotask(() => setHeadingId(element.id))}>
      {props.section.title}
    </props.level.GroupLabel>
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
    <Show when={props.item.meta}>{(meta) => <span class="k2-mi-meta">{meta()}</span>}</Show>
    {props.end}
  </>
);

/**
 * An entry that opens a panel (a calendar) beside it: a menu item, so the menu's keys reach it, that is also the
 * trigger of its own popover. The popover is a dialog of its own at the end of the page, a layer over the menu: the
 * menu never sees its keys, a press inside it is no press outside the menu, Escape closes it first and puts the focus
 * back on the entry. Enter, Space and the arrow to the side open it, as they open a submenu; it stays open while the
 * menu's data changes (a clock that moved on keeps what was typed in it). On the phone it is a sheet of its own.
 */
const PanelEntry = (props: { level: MenuLevelParts; item: MenuItem; keyed: Record<string, unknown>; lead: boolean }) => {
  const phone = usePhone();
  const [open, setOpen] = createSignal(false);
  const popover = usePopover(() => ({ open: open(), onOpenChange: setOpen, modal: true, presentation: phone() ? "sheet" : "popover" }));
  const [entry, setEntry] = createSignal<HTMLElement>();
  createEffect(() => {
    const element = entry();
    if (!element) return;
    onCleanup(popover.bindTrigger(element));
    // the menu's Enter would choose the entry and its arrow to the side does nothing here: both open the panel
    const keys = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " " && event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(true);
    };
    element.addEventListener("keydown", keys);
    onCleanup(() => element.removeEventListener("keydown", keys));
  });
  // beside the entry on the side its menu opened to, so it never covers the way it came
  const side = () => (entry()?.closest(".k2-menu")?.getAttribute("data-side") === "left" ? "left" : "right");
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
          class="k2-pop k2-dpop"
          data-k2-part="Popover"
          aria-label={props.item.label}
          side={side()}
          align="start"
          sideOffset={4}
          collisionPadding={8}
        >
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
        <sub.Popup class="k2-menu" data-k2-part="Menu" side={side()} sideOffset={4} collisionPadding={8}>
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
const MenuRoot = (props: MenuProps) => {
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
      >
        <TriggerFace icon={props.icon ?? (iconOnly() ? "dots" : undefined)} label={words()} iconOnly={iconOnly()} chevron={!iconOnly()} />
      </level.Trigger>
      <level.Popup class="k2-menu" data-k2-part="Menu" side="bottom" align={align()} sideOffset={4} collisionPadding={8}>
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
      <level.Popup class="k2-menu" data-k2-part="Menu" side="bottom" align={align()} sideOffset={4} collisionPadding={8}>
        <Entries level={level} entries={props.items} />
      </level.Popup>
    </>
  );
};

export type MenuContextProps = {
  items: readonly MenuEntry[];
  /** The one element the menu belongs to, such as a `Row`; it gets no wrapper. */
  children: JSX.Element;
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
        <level.Popup class="k2-menu" data-k2-part="Menu" collisionPadding={8}>
          <Entries level={level} entries={props.items} />
        </level.Popup>
      </PageLayer>
    </>
  );
};

/** A menu behind a button, or with `Menu.Context` on a thing itself. */
export const Menu = Object.assign(MenuRoot, { Context: MenuContext });
