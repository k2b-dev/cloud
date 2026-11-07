import { type Accessor, createEffect, createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { useUiMessages } from "../intl/messages";
import {
  type CommandContext,
  type CommandGroup,
  type CommandItem,
  type CommandSource,
  commandKey,
  groupCommandItems,
  resolveCommandSource,
} from "./command-items";
import { useCommandMessages } from "./command-messages";

/** The state of one open command list: its steps, the shown entries, and the marked one. */
export type CommandNavigator = ReturnType<typeof createCommandNavigator>;

/** A command that returned a promise: busy while it runs, or failed with the message of its rejection. */
export type CommandStatus = { key: string; state: "running" } | { key: string; state: "failed"; message?: string };

/**
 * Keeps the steps, the marked entry, and the running command of a command list. The host owns the query and the
 * effects: `onText` places an entry's text; for an entry with `onSelect`, `beforeRun` lets the host remove its query,
 * `context` describes the text the command acts on, and `afterRun` closes the list once the command finished.
 * `onStep` runs after a second list opened or closed, so the host clears its query.
 */
export const createCommandNavigator = (options: {
  items: Accessor<CommandSource>;
  query: Accessor<string>;
  onText: (item: CommandItem) => void;
  context: (signal: AbortSignal) => CommandContext;
  beforeRun?: () => void;
  afterRun: () => void;
  onStep?: () => void;
}) => {
  const [status, setStatus] = createSignal<CommandStatus>();
  let running: AbortController | undefined;
  const run = (item: CommandItem) => {
    const controller = new AbortController();
    running = controller;
    const key = commandKey(item);
    setStatus(undefined);
    options.beforeRun?.();
    const settle = (failure?: { error: unknown }) => {
      if (running !== controller || controller.signal.aborted) return;
      running = undefined;
      if (!failure) {
        setStatus(undefined);
        options.afterRun();
        return;
      }
      const message = failure.error instanceof Error && failure.error.message ? failure.error.message : undefined;
      setStatus({ key, state: "failed", message });
    };
    let result: unknown;
    try {
      result = item.onSelect?.(options.context(controller.signal));
    } catch (error) {
      settle({ error });
      return;
    }
    if (!(result instanceof Promise)) return settle();
    setStatus({ key, state: "running" });
    result.then(
      () => settle(),
      (error: unknown) => settle({ error }),
    );
  };
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
    if (item && !item.disabled) setWanted({ key: commandKey(item), query: options.query(), step: step() });
  };
  /** The next entry that can be chosen from `from` in `direction`, wrapping; unavailable entries are passed over. */
  const nextEnabled = (from: number, direction: 1 | -1) => {
    const list = ordered();
    for (let step = 1; step <= list.length; step++) {
      const index = (((from + direction * step) % list.length) + list.length) % list.length;
      if (!list[index]?.disabled) return index;
    }
    return from;
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
    /** Marks the next or previous entry, wrapping; unavailable entries are passed over, as in a searchable menu. */
    move: (delta: 1 | -1) => setActive(nextEnabled(active(), delta)),
    edge: (which: "first" | "last") => setActive(which === "first" ? nextEnabled(-1, 1) : nextEnabled(ordered().length, -1)),
    status,
    /** Whether a command's promise is pending; the list then waits for it. */
    busy: () => status()?.state === "running",
    /** Chooses the marked entry or the one at `index`. An unavailable entry, or any while a command runs, does nothing. */
    choose: (index = active()) => {
      const item = ordered()[index];
      if (!item || item.disabled || status()?.state === "running") return;
      if (item.next) changeStep([...steps(), item]);
      else if (item.text !== undefined) options.onText(item);
      else run(item);
    },
    /** Stops a running command: its signal aborts, and its result no longer reaches the list. */
    abort: () => {
      running?.abort();
      running = undefined;
      setStatus(undefined);
    },
    /** Leaves the second list; `false` when the first list shows. */
    back: () => {
      if (steps().length === 0) return false;
      changeStep(steps().slice(0, -1));
      return true;
    },
    /** Forgets steps, mark, and status. A running command goes on, but its result no longer reaches the list. */
    reset: () => {
      running = undefined;
      setSteps([]);
      setWanted(undefined);
      setStatus(undefined);
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
}): JSX.Element {
  const messages = useUiMessages();
  const commandMessages = useCommandMessages();
  const nav = props.navigator;
  const matches = () => nav.entries().filter((item) => !item.disabled).length;
  // The focus stays in the field, so the marked row scrolls into view itself.
  createEffect(() => {
    if (nav.entries().length === 0) return;
    document.getElementById(commandOptionId(props.id, nav.active()))?.scrollIntoView?.({ block: "nearest" });
  });
  const statusOf = (item: CommandItem) => {
    const current = nav.status();
    return current?.key === commandKey(item) ? current : undefined;
  };
  const runningLabel = () => {
    const current = nav.status();
    const item = current?.state === "running" ? nav.entries().find((entry) => commandKey(entry) === current.key) : undefined;
    return item ? commandMessages().running({ label: item.label }) : "";
  };
  const failure = () => {
    const current = nav.status();
    return current?.state === "failed" ? (current.message ?? commandMessages().failed) : "";
  };
  const status = () => {
    if (runningLabel()) return runningLabel();
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
              aria-label={commandMessages().back({ label: item().label })}
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
                      aria-busy={statusOf(entry.item)?.state === "running" ? "true" : undefined}
                      data-active={entry.index === nav.active() && !entry.item.disabled ? "" : undefined}
                      data-failed={statusOf(entry.item)?.state === "failed" ? "" : undefined}
                      onPointerMove={() => {
                        if (entry.index !== nav.active()) nav.setActive(entry.index);
                      }}
                      onClick={() => nav.choose(entry.index)}
                    >
                      <Show
                        when={statusOf(entry.item)?.state !== "running"}
                        fallback={<i class="ti ti-loader-2 k2b-spin k2b-command-list__busy" aria-hidden="true" />}
                      >
                        <Show when={entry.item.leading} fallback={<CommandVisual item={entry.item} />}>
                          {(leading) => (
                            <span class="k2b-command-list__leading" aria-hidden="true">
                              {leading()()}
                            </span>
                          )}
                        </Show>
                      </Show>
                      {/* One line: the label, then quietly a failure, the reason it is unavailable, or what it does. */}
                      <span class="k2b-dropdown__copy k2b-command-list__text">
                        <span>{entry.item.label}</span>
                        <Show
                          when={statusOf(entry.item)?.state === "failed"}
                          fallback={
                            <Show when={entry.item.disabled ?? entry.item.description}>
                              {(text) => <small class="k2b-command-list__description">{text()}</small>}
                            </Show>
                          }
                        >
                          {/* The alert below reads it in full; the title shows it where it is cut. */}
                          <small class="k2b-command-list__description k2b-command-list__error" title={failure()} aria-hidden="true">
                            <i class="ti ti-alert-circle" aria-hidden="true" />
                            <span>{failure()}</span>
                          </small>
                        </Show>
                      </span>
                      <Show when={statusOf(entry.item)?.state !== "failed" && entry.item.hint}>
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
      <span class="k2b-sr-only" role="alert">
        {failure()}
      </span>
    </>
  );
}

/** An entry's image, one per theme when it has two, at icon size; or its icon. */
function CommandVisual(props: { item: CommandItem }): JSX.Element {
  const image = () => props.item.image;
  return (
    <Show when={image()} fallback={<Show when={props.item.icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>}>
      {(source) => (
        <span class="k2b-command-list__image" aria-hidden="true">
          <Show
            when={typeof source() === "object" ? (source() as { light: string; dark: string }) : undefined}
            fallback={<img src={source() as string} alt="" width="16" height="16" decoding="async" />}
          >
            {(pair) => (
              <>
                <img class="k2b-command-list__image-light" src={pair().light} alt="" width="16" height="16" decoding="async" />
                <img class="k2b-command-list__image-dark" src={pair().dark} alt="" width="16" height="16" decoding="async" />
              </>
            )}
          </Show>
        </span>
      )}
    </Show>
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
