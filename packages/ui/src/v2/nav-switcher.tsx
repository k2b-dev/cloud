import { Link } from "@k2b/ssr/nav";
import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { useLocale } from "../intl/locale";
import { quietFocus, usePopover } from "./behavior/overlays";
import type { NavSwitcher, NavSwitcherOption, NavSwitcherPart } from "./components";
import { Input } from "./controls";
import { linkOr } from "./link";
import { Icon, Mark } from "./marks";

// The switcher of a `Nav` in a module of its own: `navSwitcher` brings it along, so a `Nav` without one (and every
// island that loads only a Workspace, a Nav and a Menu) loads none of its code, as `navTree` and `menuPanel` do.

/** A `Nav` `switcher`: the open thing and the others, with the code that shows them (see `NavSwitcher`). */
export const navSwitcher = (switcher: NavSwitcher): NavSwitcherPart => ({ ...switcher, view: NavSwitch });

/** From this many options the switcher shows its search. */
const SWITCHER_SEARCH_FROM = 8;
/**
 * The most options the panel lists before a search (the ones opened last and the first of the rest), and the most
 * matches of a search: the panel stays a short list however many things an app holds; the search reaches the others.
 */
const SWITCHER_SHOWN = 20;
const SWITCHER_MATCHES = 50;

/**
 * The open thing as a button across the column (its mark, its name, ↕); behind it a panel of the others in their
 * groups, the search from 8, and the deeds. Arrow keys move between the entries, from the search into the list; choosing
 * one closes the panel; Home and End go to the ends; Enter in the search opens the first match. On the phone the sidebar leaves, and the shell's menu shows the switcher there
 * (`V2WorkspaceNavigation` `switcher`).
 */
const NavSwitch = (props: { switcher: NavSwitcher }) => {
  const locale = useLocale();
  const purpose = `k2-switch-${createUniqueId()}`;
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const popover = usePopover(() => ({
    open: open(),
    onOpenChange: (next: boolean) => {
      setOpen(next);
      if (!next) setQuery("");
    },
  }));
  const searchable = () => props.switcher.options.length >= SWITCHER_SEARCH_FROM;
  const searching = () => query().trim() !== "";
  const found = createMemo(() => {
    const needle = query().trim().toLocaleLowerCase(locale());
    return needle
      ? props.switcher.options.filter((option) => option.label.toLocaleLowerCase(locale()).includes(needle))
      : props.switcher.options;
  });
  const shown = createMemo(() => found().slice(0, searching() ? SWITCHER_MATCHES : SWITCHER_SHOWN));
  // options one after another with the same group form one section under its heading
  const sections = createMemo(() => {
    const out: { group?: string; options: NavSwitcherOption[] }[] = [];
    for (const option of shown()) {
      const last = out.at(-1);
      if (last && last.group === option.group) last.options.push(option);
      else out.push({ group: option.group, options: [option] });
    }
    return out;
  });
  // one quiet line in one place: nothing found, or how many the list leaves out; it stays where it is, so nothing moves
  const status = () =>
    !shown().length
      ? props.switcher.noMatch
      : found().length > shown().length
        ? props.switcher.more(found().length - shown().length, searching())
        : "";
  let panel: HTMLElement | undefined;
  const entries = () => [...(panel?.querySelectorAll<HTMLElement>(".k2-mi") ?? [])];
  const searchField = () => panel?.querySelector<HTMLInputElement>("input[type=search]") ?? undefined;
  const keys = (event: KeyboardEvent) => {
    const all = entries();
    const inSearch = event.target === searchField();
    if (event.key === "Enter" && inSearch) {
      // Enter in the search opens the first match
      event.preventDefault();
      panel?.querySelector<HTMLElement>(".k2-mi[data-option]")?.click();
      return;
    }
    if (!all.length) return;
    if ((event.key === "Home" || event.key === "End") && !inSearch) {
      event.preventDefault();
      (event.key === "Home" ? all[0] : all.at(-1))?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const at = all.findIndex((entry) => entry === document.activeElement);
    const next = event.key === "ArrowDown" ? (at + 1) % all.length : at <= 0 ? -1 : at - 1;
    // up from the first entry goes back into the search, where there is one
    if (next === -1) (searchField() ?? all.at(-1))?.focus();
    else all[next]?.focus();
  };
  // the first focus: the search where there is one (not on a touch screen, where its keyboard would cover the list),
  // else the open thing, as the shell's switcher has it
  const firstFocus = () =>
    queueMicrotask(() => {
      const search = searchField();
      const target =
        search && !matchMedia("(pointer: coarse)").matches
          ? search
          : (panel?.querySelector<HTMLElement>('.k2-mi[aria-current="page"]') ?? entries()[0]);
      if (!target) return;
      // without a ring after a press; after a key the ring shows where the focus stands
      quietFocus(target);
      if (document.activeElement !== target) target.focus({ preventScroll: true });
    });
  const close = () => setOpen(false);
  const plainClick = (event: MouseEvent) => event.button === 0 && !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
  return (
    <>
      <popover.Trigger
        class="k2-nav-switch"
        data-k2-part="NavSwitcher"
        // the button is called what it shows, the open thing; what it does is its description
        aria-label={props.switcher.current ? undefined : props.switcher.label}
        aria-describedby={props.switcher.current ? purpose : undefined}
      >
        <Show when={props.switcher.current} fallback={<span class="k2-nav-switch-name">{props.switcher.label}</span>}>
          {(current) => (
            <>
              <Mark icon={current().icon} color={current().color} />
              <span class="k2-nav-switch-name">{current().label}</span>
              <span id={purpose} hidden>
                {props.switcher.label}
              </span>
            </>
          )}
        </Show>
        <Icon name="selector" />
      </popover.Trigger>
      <popover.Popup
        ref={(element: HTMLElement) => {
          panel = element;
          firstFocus();
        }}
        class="k2-menu k2-switcher"
        side="bottom"
        align="start"
        sideOffset={4}
        collisionPadding={8}
        onKeyDown={keys}
      >
        <Show when={searchable()}>
          <div class="k2-switcher-search">
            <Input
              type="search"
              icon="search"
              label={props.switcher.search}
              placeholder={props.switcher.search}
              value={query()}
              onInput={setQuery}
            />
          </div>
        </Show>
        <For each={sections()}>
          {(section) => (
            // a named run of options is a group; an unnamed run is only a run
            <div class="k2-mgroup" {...(section.group ? { role: "group", "aria-label": section.group } : {})}>
              <Show when={section.group}>{(group) => <div class="k2-mh">{group()}</div>}</Show>
              <For each={section.options}>
                {(option) => (
                  <Link
                    class="k2-mi"
                    data-option=""
                    href={option.href}
                    onNavigate={option.onNavigate}
                    aria-current={option.current ? "page" : undefined}
                    onClick={(event: MouseEvent) => {
                      // the open thing is here already: choosing it only closes the panel
                      if (option.current && plainClick(event)) event.preventDefault();
                      close();
                    }}
                  >
                    <span class="k2-mi-lead">
                      <Mark icon={option.icon} color={option.color} />
                    </span>
                    <span class="k2-mi-label">{option.label}</span>
                    <Show when={option.meta}>{(meta) => <span class="k2-mi-meta">{meta()}</span>}</Show>
                    <Show when={option.current}>
                      <Icon name="check" />
                    </Show>
                  </Link>
                )}
              </For>
            </div>
          )}
        </For>
        <div class="k2-switcher-none" role="status" data-said={status() ? "" : undefined}>
          {status()}
        </div>
        <Show when={props.switcher.actions?.length}>
          <div class="k2-msep" />
          <For each={props.switcher.actions}>
            {(action) => (
              <Dynamic
                component={linkOr(action.href, "button")}
                class="k2-mi"
                href={action.href}
                onNavigate={action.onNavigate}
                type={action.href === undefined ? "button" : undefined}
                onClick={() => {
                  action.onClick?.();
                  close();
                }}
              >
                <span class="k2-mi-lead">
                  <Icon name={action.icon ?? "plus"} />
                </span>
                <span class="k2-mi-label">{action.label}</span>
              </Dynamic>
            )}
          </For>
        </Show>
      </popover.Popup>
    </>
  );
};
