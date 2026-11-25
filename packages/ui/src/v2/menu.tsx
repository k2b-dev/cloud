import { createEffect, createMemo, createSignal, For, type JSX, onCleanup, children as resolveChildren, Show, untrack } from "solid-js";
import { type MenuLevelParts, useMenuLevels } from "./behavior/menu";
import { Icon } from "./marks";
import { useOverlayMessages } from "./overlay-messages";
import { PageLayer } from "./page-layer";

/**
 * One entry of a menu, as data. `onClick` runs it; a Promise keeps the menu open and the entry busy until it settles.
 * `href` makes it a link. `checked` makes it an entry that toggles (the tick stands at its end, like in a selection).
 * `items` opens a submenu to the side. `danger` is red and stands after a line.
 */
export type MenuItem = {
  label: string;
  /** A Tabler icon name without the `ti-` prefix. */
  icon?: string;
  onClick?: () => unknown;
  href?: string;
  /** Red, for a deed that destroys; the menu puts a line before the first one. */
  danger?: boolean;
  disabled?: boolean;
  /** A quiet hint at the end, such as the key that does the same ("⌘ D"). */
  meta?: string;
  /** An entry that toggles: `onClick` flips it. */
  checked?: boolean;
  /** A submenu, opened to the side. */
  items?: readonly MenuEntry[];
};

/** An entry, or a line between groups of entries. */
export type MenuEntry = MenuItem | "separator";

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

/** A line before the first dangerous entry after others; no line at the start, the end or twice. */
export const menuEntries = (entries: readonly MenuEntry[]): MenuEntry[] => {
  const out: MenuEntry[] = [];
  for (const entry of entries) {
    const last = out.at(-1);
    if (entry !== "separator" && entry.danger && last !== undefined && last !== "separator" && !last.danger) out.push("separator");
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

const Entries = (props: { level: MenuLevelParts; entries: readonly MenuEntry[] }) => {
  // every entry keeps the place of the symbol once one entry has a symbol, so the words line up
  const lead = () => props.entries.some((entry) => entry !== "separator" && entry.icon);
  // Keyed by kind and words, not by object or place: new data for an open menu (a tick that flipped, an entry that
  // came in before it) keeps every entry's element, so the highlight and the focus stay. An entry that turns into
  // another kind gets a new key and is made anew, with the right role and handler.
  const keyed = createMemo(() => {
    const seen = new Map<string, number>();
    return menuEntries(props.entries).map((entry, index) => {
      const base = entry === "separator" ? `separator:${index}` : `${kindOf(entry)}:${entry.label}`;
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      return { key: count ? `${base}#${count}` : base, entry };
    });
  });
  return (
    <For each={keyed().map((each) => each.key)}>
      {(key) => {
        const entry = () => keyed().find((each) => each.key === key)?.entry ?? "separator";
        const kind = untrack(() => kindOf(entry()));
        return kind === "separator" ? (
          <props.level.Separator class="k2-msep" />
        ) : (
          <Entry level={props.level} kind={kind} item={itemOf(entry())} value={key} lead={lead()} />
        );
      }}
    </For>
  );
};

type EntryKind = "separator" | "submenu" | "tick" | "link" | "deed";

const kindOf = (entry: MenuEntry): EntryKind =>
  entry === "separator"
    ? "separator"
    : entry.items
      ? "submenu"
      : entry.checked !== undefined
        ? "tick"
        : entry.href !== undefined && !entry.disabled
          ? "link"
          : "deed";

const itemOf = (entry: MenuEntry): MenuItem => (entry === "separator" ? { label: "" } : entry);

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

/** One entry of one kind (submenu, tick, link, deed); its words and states follow the data. */
const Entry = (props: { level: MenuLevelParts; kind: Exclude<EntryKind, "separator">; item: MenuItem; value: string; lead: boolean }) => {
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
    return (
      <>
        <sub.Trigger {...shared}>
          <EntryFace item={props.item} lead={props.lead} end={<Icon name="chevron-right" />} />
        </sub.Trigger>
        <sub.Popup class="k2-menu" data-k2-part="Menu" sideOffset={4} collisionPadding={8}>
          <Entries level={sub} entries={props.item.items ?? []} />
        </sub.Popup>
      </>
    );
  }
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
      <props.level.LinkItem {...keyed} href={props.item.href}>
        <EntryFace item={props.item} lead={props.lead} />
      </props.level.LinkItem>
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
  const level = useMenuLevels(() => ({
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
  const level = useMenuLevels(() => ({
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
