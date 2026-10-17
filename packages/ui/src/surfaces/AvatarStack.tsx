import { createMemo, createSignal, createUniqueId, For, type JSX, onCleanup, Show } from "solid-js";
import { dropdownPosition } from "../actions/Dropdown";
import { prefersMenuSheet } from "../actions/menu-sheet";
import { dialogCore } from "../feedback/dialog-core";
import { LocaleProvider, useLocale } from "../intl/locale";
import BottomSheet, { bottomSheetOptions } from "../layout/BottomSheet";
import { Avatar, type AvatarShape } from "./Avatar";
import { useAvatarMessages } from "./avatar-messages";

export type AvatarStackPerson = {
  /** Stable key, such as the account id. */
  id: string;
  name: string;
  src?: string | null;
  /** Shown instead of initials when there is no picture. */
  icon?: string;
  /** `square` for agents and service accounts. */
  shape?: AvatarShape;
  /** A short tag after the name, such as "Agent". */
  badge?: JSX.Element;
  /** One line below the name; it ends with an ellipsis instead of wrapping. */
  detail?: JSX.Element;
  /** Icon class before `detail`. */
  detailIcon?: string;
  /** Short text at the end of the row, such as "2 tabs". */
  trailing?: JSX.Element;
  /** The person viewing: listed last, below a gap, and never in the stack. */
  self?: boolean;
  /** Makes the row a button. The list closes first. */
  onSelect?: () => void;
};

export type AvatarStackProps = {
  people: readonly AvatarStackPerson[];
  /** Title of the list that the stack opens, such as "Here now". */
  title: string;
  /** Accessible name of the stack button, such as "Here now: Jana Berger and 2 more". */
  label: string;
  /** One quiet line below the list. */
  hint?: JSX.Element;
  /** Faces before "+n". Defaults to 3. */
  max?: number;
  class?: string;
};

const PersonRows = (props: { people: readonly AvatarStackPerson[]; choose: (person: AvatarStackPerson) => void }): JSX.Element => {
  let list!: HTMLUListElement;
  /**
   * A focused row that stops being a button (the person can no longer be chosen) or leaves hands focus to the nearest
   * row that still is one, else to the list, so focus never drops out of the open list.
   */
  const keepFocus = (button: HTMLButtonElement) => {
    if (!button.contains(document.activeElement)) return;
    const buttons = Array.from(list.querySelectorAll<HTMLButtonElement>("button.k2b-avatar-stack__row"));
    const index = buttons.indexOf(button);
    const candidates = [...buttons.slice(index + 1), ...buttons.slice(0, Math.max(0, index)).reverse()];
    queueMicrotask(() => {
      if (!list.isConnected) return;
      (candidates.find((candidate) => candidate.isConnected) ?? list).focus();
    });
  };
  const others = () => props.people.filter((person) => !person.self);
  const selves = () => props.people.filter((person) => person.self);
  // A row reads its person through an accessor, so a live update changes the row in place and a focused row keeps focus.
  const row = (person: () => AvatarStackPerson) => {
    const content = (
      <>
        <Avatar name={person().name} src={person().src} icon={person().icon} shape={person().shape} size="sm" />
        <span class="k2b-avatar-stack__row-copy">
          <span class="k2b-avatar-stack__row-name">
            <span>{person().name}</span>
            <Show when={person().badge}>
              <span class="k2b-avatar-stack__row-badge">{person().badge}</span>
            </Show>
          </span>
          <Show when={person().detail}>
            <span class="k2b-avatar-stack__row-detail">
              <Show when={person().detailIcon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>
              <span>{person().detail}</span>
            </span>
          </Show>
        </span>
        <Show when={person().trailing}>
          <span class="k2b-avatar-stack__row-trailing">{person().trailing}</span>
        </Show>
      </>
    );
    return (
      <li data-self={person().self ? "true" : undefined}>
        <Show when={Boolean(person().onSelect)} fallback={<div class="k2b-avatar-stack__row">{content}</div>}>
          {(() => {
            let button!: HTMLButtonElement;
            onCleanup(() => keepFocus(button));
            return (
              <button ref={button} type="button" class="k2b-avatar-stack__row" onClick={() => props.choose(person())}>
                {content}
              </button>
            );
          })()}
        </Show>
      </li>
    );
  };
  // Rows follow each person by id: a row stays with its person when others leave or the order changes, and still
  // shows that person's latest details.
  const byId = createMemo(() => new Map(props.people.map((person) => [person.id, person])));
  const keyed = (id: string) => row(() => byId().get(id) ?? { id, name: "" });
  return (
    <ul ref={list} class="k2b-avatar-stack__rows" tabIndex={-1}>
      <For each={others().map((person) => person.id)}>{keyed}</For>
      <For each={selves().map((person) => person.id)}>{keyed}</For>
    </ul>
  );
};

const PeopleList = (props: {
  people: readonly AvatarStackPerson[];
  title: string;
  titleId: string;
  hint?: JSX.Element;
  choose: (person: AvatarStackPerson) => void;
}): JSX.Element => (
  <>
    <header class="k2b-avatar-stack__header">
      <h3 id={props.titleId}>{props.title}</h3>
      <span class="k2b-count-chip">{props.people.length}</span>
    </header>
    <PersonRows people={props.people} choose={props.choose} />
    <Show when={props.hint}>
      <p class="k2b-avatar-stack__hint">{props.hint}</p>
    </Show>
  </>
);

/**
 * A few overlapping faces, then "+n", as one button. It opens the full list of people beside it, or as a bottom sheet
 * on phones. People with `self` are listed last and never shown in the stack.
 */
export function AvatarStack(props: AvatarStackProps): JSX.Element {
  const locale = useLocale();
  const messages = useAvatarMessages();
  const id = createUniqueId().replace(/[^a-zA-Z0-9_-]/g, "-");
  const popoverId = `k2b-avatar-stack-${id}`;
  const titleId = `${popoverId}-title`;
  const [open, setOpen] = createSignal(false);
  let trigger!: HTMLButtonElement;
  let popover!: HTMLDivElement;
  let sheetOpen = false;
  const disposed = new AbortController();
  onCleanup(() => disposed.abort());

  const faces = () => props.people.filter((person) => !person.self);
  const max = () => Math.max(1, props.max ?? 3);
  const shown = () => faces().slice(0, max());
  const more = () => Math.max(0, faces().length - max());

  const place = () => {
    const rect = dropdownPosition(trigger.getBoundingClientRect(), popover.getBoundingClientRect(), "bottom-left", {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    popover.style.left = `${rect.left}px`;
    popover.style.top = `${rect.top}px`;
  };
  // Like a dropdown menu, the open list follows its trigger when the window resizes or scrolls, and its own size.
  let resizeObserver: ResizeObserver | undefined;
  const follow = (on: boolean) => {
    const method = on ? "addEventListener" : "removeEventListener";
    window[method]("resize", place);
    window[method]("scroll", place, true);
    if (on && typeof ResizeObserver !== "undefined") {
      resizeObserver ??= new ResizeObserver(place);
      resizeObserver.observe(popover);
    } else resizeObserver?.disconnect();
  };
  onCleanup(() => follow(false));

  const openSheet = () => {
    if (sheetOpen) return;
    sheetOpen = true;
    setOpen(true);
    let chosen: AvatarStackPerson | undefined;
    const current = locale();
    void dialogCore
      .open<void>(
        (close, context) => (
          <LocaleProvider locale={current}>
            <BottomSheet onDismiss={context.requestDismiss}>
              <BottomSheet.Body>
                <div class="k2b-avatar-stack__sheet" role="group" aria-labelledby={`${titleId}-sheet`}>
                  <PeopleList
                    people={props.people}
                    title={props.title}
                    titleId={`${titleId}-sheet`}
                    hint={props.hint}
                    choose={(person) => {
                      chosen = person;
                      close();
                    }}
                  />
                </div>
              </BottomSheet.Body>
            </BottomSheet>
          </LocaleProvider>
        ),
        { ...bottomSheetOptions, ariaLabel: props.title, history: true, signal: disposed.signal },
      )
      .then(() => chosen?.onSelect?.())
      .finally(() => {
        sheetOpen = false;
        setOpen(false);
      });
  };

  const toggle = () => {
    if (prefersMenuSheet()) {
      openSheet();
      return;
    }
    if (popover.matches(":popover-open")) {
      popover.hidePopover();
      return;
    }
    popover.showPopover();
    place();
  };

  return (
    <span class={`k2b-avatar-stack ${props.class ?? ""}`}>
      <button
        ref={trigger}
        type="button"
        class="k2b-avatar-stack__trigger"
        aria-label={props.label}
        aria-haspopup="dialog"
        aria-expanded={open()}
        aria-controls={popoverId}
        onClick={toggle}
      >
        <span class="k2b-avatar-stack__faces" aria-hidden="true">
          <For each={shown()}>
            {(person) => <Avatar name={person.name} src={person.src} icon={person.icon} shape={person.shape} size="xs" alt="" />}
          </For>
        </span>
        <Show when={more() > 0}>
          <span class="k2b-avatar-stack__more" aria-hidden="true" title={messages().moreCount({ count: more() })}>
            +{more()}
          </span>
        </Show>
      </button>
      <div
        ref={popover}
        id={popoverId}
        popover="auto"
        role="dialog"
        aria-labelledby={titleId}
        class="k2b-avatar-stack__popover"
        onToggle={(event) => {
          const next = (event as ToggleEvent).newState === "open";
          setOpen(next);
          follow(next);
          if (!next && document.activeElement && popover.contains(document.activeElement)) trigger.focus();
        }}
      >
        <PeopleList
          people={props.people}
          title={props.title}
          titleId={titleId}
          hint={props.hint}
          choose={(person) => {
            if (open()) popover.hidePopover();
            person.onSelect?.();
          }}
        />
      </div>
    </span>
  );
}
