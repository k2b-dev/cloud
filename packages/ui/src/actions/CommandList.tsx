import { type Accessor, createEffect, createMemo, createSignal, For, type JSX, Show } from "solid-js";
import type { UiMessages } from "../intl/messages";
import {
  type CommandGroup,
  type CommandItem,
  type CommandSource,
  commandKey,
  groupCommandItems,
  resolveCommandSource,
} from "./command-items";

/** The state of one open command list: its steps, the shown entries, and the marked one. */
export type CommandNavigator = ReturnType<typeof createCommandNavigator>;

/**
 * Keeps the steps and the marked entry of a command list. The host owns the query and the effects: `onPick` runs for
 * an entry with `onSelect` or `text`, and `onStep` after a second list opened or closed, so the host clears its query.
 */
export const createCommandNavigator = (options: {
  items: Accessor<CommandSource>;
  query: Accessor<string>;
  onPick: (item: CommandItem) => void;
  onStep?: () => void;
}) => {
  const [steps, setSteps] = createSignal<readonly CommandItem[]>([]);
  const step = () => steps().at(-1);
  const entries = createMemo(() => {
    const current = step()?.next;
    return resolveCommandSource(current ? current.items : options.items(), options.query());
  });
  const groups = createMemo<CommandGroup[]>(() => groupCommandItems(entries()));
  const ordered = createMemo(() => groups().flatMap((group) => group.entries.map((entry) => entry.item)));
  // The marked entry is remembered for the query and step it was marked in; a new query marks the first entry again.
  const [wanted, setWanted] = createSignal<{ key: string; query: string; step: CommandItem | undefined }>();
  const active = createMemo(() => {
    const list = ordered();
    const mark = wanted();
    if (mark && mark.query === options.query() && mark.step === step()) {
      const index = list.findIndex((item) => commandKey(item) === mark.key);
      if (index >= 0) return index;
    }
    const enabled = list.findIndex((item) => !item.disabled);
    return enabled >= 0 ? enabled : 0;
  });
  const setActive = (index: number) => {
    const list = ordered();
    const item = list[(index + list.length) % Math.max(1, list.length)];
    if (item) setWanted({ key: commandKey(item), query: options.query(), step: step() });
  };
  const changeStep = (next: readonly CommandItem[]) => {
    setSteps(next);
    setWanted(undefined);
    options.onStep?.();
  };

  return {
    step,
    groups,
    entries: ordered,
    active,
    setActive,
    /** Marks the next or previous entry, wrapping; unavailable entries are marked too, so their reason is heard. */
    move: (delta: 1 | -1) => setActive(active() + delta),
    edge: (which: "first" | "last") => setActive(which === "first" ? 0 : ordered().length - 1),
    /** Chooses the marked entry or the one at `index`. An unavailable entry does nothing. */
    choose: (index = active()) => {
      const item = ordered()[index];
      if (!item || item.disabled) return;
      if (item.next) changeStep([...steps(), item]);
      else options.onPick(item);
    },
    /** Leaves the second list; `false` when the first list shows. */
    back: () => {
      if (steps().length === 0) return false;
      changeStep(steps().slice(0, -1));
      return true;
    },
    reset: () => {
      setSteps([]);
      setWanted(undefined);
    },
  };
};

export const commandOptionId = (listId: string, index: number) => `${listId}-${index}`;

/**
 * The rows of a command list as a list box, with the menu's own rows and headings. The focus stays in the host's
 * field, which points at the marked row as its active descendant; the rows only answer the pointer.
 */
export function CommandList(props: {
  navigator: CommandNavigator;
  id: string;
  /** Names the first list; a second list is named by its step. */
  label: string;
  /** Shows the step's label beside the back control, for a host without its own search field. */
  stepHint?: boolean;
  /** Says how many entries match, after the query changed. */
  query: Accessor<string>;
  /** Content between the back control and the list, such as a search field. */
  header?: JSX.Element;
  /** The host's resolved messages, so a list loaded on demand needs no locale of its own. */
  messages: () => UiMessages;
}): JSX.Element {
  const messages = props.messages;
  const nav = props.navigator;
  const matches = () => nav.entries().filter((item) => !item.disabled).length;
  // The focus stays in the field, so the marked row scrolls into view itself.
  createEffect(() => {
    if (nav.entries().length === 0) return;
    document.getElementById(commandOptionId(props.id, nav.active()))?.scrollIntoView?.({ block: "nearest" });
  });
  const status = () => {
    const step = nav.step()?.next;
    const count = props.query().trim() || step ? messages().searchMatches({ count: matches() }) : "";
    return step && count ? `${step.label}, ${count}` : count;
  };

  return (
    <>
      <Show when={nav.step()}>
        {(item) => (
          <div class="k2b-command-list__step">
            <button
              type="button"
              class="k2b-command-list__back"
              tabIndex={-1}
              aria-label={messages().backFrom({ label: item().label })}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => nav.back()}
            >
              <i class="ti ti-chevron-left" aria-hidden="true" />
              <span>{item().label}</span>
            </button>
            <Show when={props.stepHint}>
              <span class="k2b-command-list__step-hint">{item().next?.label}</span>
            </Show>
          </div>
        )}
      </Show>
      {props.header}
      {/* biome-ignore lint/a11y/useFocusableInteractive: the host's field keeps the focus and owns the keys. */}
      <div
        id={props.id}
        role="listbox"
        aria-label={nav.step()?.next?.label ?? props.label}
        class="k2b-command-list"
        // A press on a row leaves the focus in the host's field.
        onMouseDown={(event) => event.preventDefault()}
      >
        <For each={nav.groups()}>
          {(group) => {
            const headingId = `${props.id}-group-${group.entries[0]?.index ?? 0}`;
            return (
              <div class="k2b-dropdown__section" role="group" aria-labelledby={group.label ? headingId : undefined}>
                <Show when={group.label}>
                  <div id={headingId} class="k2b-dropdown__label">
                    {group.label}
                  </div>
                </Show>
                <For each={group.entries}>
                  {(entry) => (
                    // biome-ignore lint/a11y/useKeyWithClickEvents: the host's field handles the keys through aria-activedescendant.
                    <div
                      id={commandOptionId(props.id, entry.index)}
                      role="option"
                      class="k2b-dropdown__item"
                      aria-selected={entry.index === nav.active()}
                      aria-disabled={entry.item.disabled ? "true" : undefined}
                      data-active={entry.index === nav.active() ? "" : undefined}
                      onPointerMove={() => {
                        if (entry.index !== nav.active()) nav.setActive(entry.index);
                      }}
                      onClick={() => nav.choose(entry.index)}
                    >
                      <Show
                        when={entry.item.leading}
                        fallback={<Show when={entry.item.icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>}
                      >
                        {(leading) => (
                          <span class="k2b-command-list__leading" aria-hidden="true">
                            {leading()()}
                          </span>
                        )}
                      </Show>
                      <span class="k2b-dropdown__copy">
                        <span>{entry.item.label}</span>
                        <Show when={entry.item.disabled}>{(reason) => <small>{reason()}</small>}</Show>
                      </span>
                      <Show when={entry.item.hint}>
                        {(hint) => (
                          <span class="k2b-command-list__hint" aria-hidden="true">
                            {hint()}
                          </span>
                        )}
                      </Show>
                      <Show when={entry.item.next}>
                        <i class="ti ti-chevron-right k2b-command-list__next" aria-hidden="true" />
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            );
          }}
        </For>
        <Show when={nav.entries().length === 0}>
          <p class="k2b-dropdown__empty">{messages().noResults}</p>
        </Show>
      </div>
      <span class="k2b-sr-only" role="status">
        {status()}
      </span>
    </>
  );
}

/**
 * The keys of a command list in its host's field: Up, Down, Home, and End mark; Enter and Tab choose; Escape and
 * Backspace on an empty query leave a second list. Returns whether the key was used; Escape in the first list is left
 * to the host, which closes.
 */
export const commandListKey = (nav: CommandNavigator, event: KeyboardEvent, query: string): boolean => {
  if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return false;
  switch (event.key) {
    case "ArrowDown":
    case "ArrowUp":
      if (nav.entries().length === 0) return false;
      nav.move(event.key === "ArrowDown" ? 1 : -1);
      return true;
    case "Home":
    case "End":
      if (event.shiftKey || nav.entries().length === 0) return false;
      nav.edge(event.key === "Home" ? "first" : "last");
      return true;
    case "Enter":
    case "Tab":
      if (event.shiftKey || nav.entries().length === 0) return false;
      nav.choose();
      return true;
    case "Escape":
      return nav.back();
    case "Backspace":
      return query === "" && nav.back();
    default:
      return false;
  }
};
