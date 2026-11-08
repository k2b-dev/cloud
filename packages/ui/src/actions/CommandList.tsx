import { type Accessor, createEffect, createMemo, createSignal, For, type JSX, onCleanup, Show, untrack } from "solid-js";
import { useUiMessages } from "../intl/messages";
import {
  type CommandContext,
  type CommandGroup,
  type CommandItem,
  type CommandSource,
  commandKey,
  filterCommandItems,
  groupCommandItems,
} from "./command-items";
import { useCommandMessages } from "./command-messages";

/** The state of one open command list: its steps, the shown entries, and the marked one. */
export type CommandNavigator = ReturnType<typeof createCommandNavigator>;

/** The context without what the list adds itself: the query, the path, the signal, and the reports. */
export type CommandPlace = Omit<CommandContext, "query" | "path" | "signal" | "success" | "error">;

/** A list whose entries come from a promise: pending, or failed with the message of its rejection. */
export type CommandListLoad = { state: "ready" } | { state: "loading" } | { state: "failed"; message?: string };

/** A command that returned a promise, busy while it runs. */
export type CommandStatus = { key: string; label: string; state: "running" };

/**
 * What a finished command reported, shown in the list's place: a confirmation, an error (with a way to try again when
 * the command threw or rejected), or the command running again after a retry.
 */
export type CommandOutcome =
  | { state: "success"; message: string }
  | { state: "error"; message?: string; retry?: () => void }
  | { state: "running"; message: string };

/** A confirmation or an error stays at least this long, even when the person types on at once. */
export const COMMAND_OUTCOME_MIN_MS = 1200;
/** A confirmation goes by itself after this long; an error stays until the person types, retries, or presses Escape. */
export const COMMAND_OUTCOME_SUCCESS_MS = 4000;

const ignoreReport = () => {};

/**
 * Keeps the steps, the marked entry, and the running command of a command list. The host owns the query and the
 * effects: `onText` places an entry's text; for an entry with `onSelect`, `beforeRun` lets the host remove its query,
 * `context` describes the text the command acts on, and `afterRun` closes the list once the command finished.
 * `onStep` runs after a further list opened or closed, with the new depth, so the host clears its query.
 */
export const createCommandNavigator = (options: {
  items: Accessor<CommandSource>;
  query: Accessor<string>;
  onText: (item: CommandItem) => void;
  /** The part of the context the host knows: the text and where the list is in it. */
  context: () => CommandPlace;
  /** Whether the list is open; a closed list asks no source. */
  active: () => boolean;
  beforeRun?: () => void;
  /** Runs once a command finished, before its outcome shows; `outcome` tells the host to keep its place for it. */
  afterRun: (outcome: boolean) => void;
  onStep?: (depth: number) => void;
}) => {
  const [status, setStatus] = createSignal<CommandStatus>();
  const [outcome, setOutcome] = createSignal<CommandOutcome>();
  let shownAt = 0;
  let outcomeTimer: ReturnType<typeof setTimeout> | undefined;
  const clearOutcome = () => {
    clearTimeout(outcomeTimer);
    outcomeTimer = undefined;
    setOutcome(undefined);
  };
  const showOutcome = (next: CommandOutcome) => {
    clearTimeout(outcomeTimer);
    outcomeTimer = undefined;
    setOutcome(next);
    shownAt = Date.now();
    if (next.state === "success") outcomeTimer = setTimeout(clearOutcome, COMMAND_OUTCOME_SUCCESS_MS);
  };
  let running: AbortController | undefined;
  // A list that goes away forgets its run, as `reset` does: a late result reports nothing and starts no timer.
  onCleanup(() => {
    clearTimeout(outcomeTimer);
    running = undefined;
  });
  const run = (item: CommandItem, path: readonly CommandItem[], again = false) => {
    const controller = new AbortController();
    running = controller;
    const key = commandKey(item);
    setStatus(undefined);
    if (!again) options.beforeRun?.();
    // What the command reported before it finished; a stopped command's report never shows.
    let report: CommandOutcome | undefined;
    const reporting = () => running === controller && !controller.signal.aborted;
    const settle = (failure?: { error: unknown }) => {
      if (!reporting()) return;
      running = undefined;
      setStatus(undefined);
      const next: CommandOutcome | undefined = failure
        ? {
            state: "error",
            message: failure.error instanceof Error && failure.error.message ? failure.error.message : undefined,
            retry: () => runAgain(item, path),
          }
        : report;
      // The outcome takes its place before the host closes the list, so the container and its live regions stay and
      // their text changes, which is what a screen reader announces.
      if (next) showOutcome(next);
      else clearOutcome();
      options.afterRun(next !== undefined);
    };
    let result: unknown;
    try {
      const base = options.context();
      result = item.onSelect?.({
        ...base,
        // A command the person stopped writes nothing more.
        insert: (text: string) => {
          if (!controller.signal.aborted) base.insert(text);
        },
        success: (message: string) => {
          report = { state: "success", message };
        },
        error: (message: string) => {
          report = { state: "error", message };
        },
        query: options.query(),
        path,
        signal: controller.signal,
      });
    } catch (error) {
      settle({ error });
      return;
    }
    if (!(result instanceof Promise)) return settle();
    // A first run shows on its row; a retry runs where its error was.
    if (again) showOutcome({ state: "running", message: item.label });
    else setStatus({ key, label: item.label, state: "running" });
    result.then(
      () => settle(),
      (error: unknown) => settle({ error }),
    );
  };
  // The error stays until the retry's own state replaces it, so a host never sees the outcome go in between.
  const runAgain = (item: CommandItem, path: readonly CommandItem[]) => run(item, path, true);
  const [steps, setSteps] = createSignal<readonly CommandItem[]>([]);
  const step = () => steps().at(-1);
  // A source that returns a promise: each request has a token, and only the latest one's result reaches the list. A new
  // request aborts the previous one's signal, so stale results are discarded where they are made.
  const [retries, setRetries] = createSignal(0);
  const [settled, setSettled] = createSignal<{ token: object; items?: readonly CommandItem[]; error?: unknown }>();
  let pending: AbortController | undefined;
  type Request = { items?: readonly CommandItem[]; error?: unknown; token?: object };
  // Where the list is, compared by value: only a new place, query, or path asks a source again, not every selection event.
  const place = createMemo(() => options.context(), undefined, {
    equals: (a, b) =>
      a.text === b.text &&
      a.before === b.before &&
      a.atStart === b.atStart &&
      a.lineStart === b.lineStart &&
      a.selection.start === b.selection.start &&
      a.selection.end === b.selection.end,
  });
  const request = createMemo<Request>(() => {
    retries();
    pending?.abort();
    pending = undefined;
    if (!options.active()) return { items: [] };
    const source = step()?.next?.items ?? options.items();
    if (typeof source !== "function") return { items: filterCommandItems(source, options.query()) };
    const controller = new AbortController();
    const context: CommandContext = {
      ...place(),
      query: options.query(),
      path: steps(),
      signal: controller.signal,
      success: ignoreReport,
      error: ignoreReport,
    };
    let result: readonly CommandItem[] | Promise<readonly CommandItem[]>;
    try {
      result = untrack(() => source(context));
    } catch (error) {
      return { error };
    }
    if (!(result instanceof Promise)) return { items: filterCommandItems(result, context.query) };
    pending = controller;
    const token = {};
    result.then(
      (items) => {
        if (pending === controller) setSettled({ token, items: filterCommandItems(items, context.query) });
      },
      (error: unknown) => {
        if (pending === controller && !controller.signal.aborted) setSettled({ token, error });
      },
    );
    return { token };
  });
  /** Pending, failed, or ready; while a new query loads, the step's previous entries stay in place. */
  const load = createMemo<CommandListLoad>(() => {
    const current = request();
    const result = current.token ? (settled()?.token === current.token ? settled() : undefined) : current;
    if (!result) return { state: "loading" };
    if (result.error !== undefined) {
      const message = result.error instanceof Error && result.error.message ? result.error.message : undefined;
      return { state: "failed", message };
    }
    return { state: "ready" };
  });
  // Only entries of the same step stay while a query loads: a further list never shows the list it came from.
  const shown = createMemo<{ step: CommandItem | undefined; items: readonly CommandItem[] }>(
    (previous) => {
      const current = request();
      const at = step();
      if (!current.token) return { step: at, items: current.items ?? [] };
      const result = settled();
      if (result?.token === current.token) return { step: at, items: result.items ?? [] };
      return { step: at, items: previous.step === at ? previous.items : [] };
    },
    { step: undefined, items: [] },
  );
  const entries = () => shown().items;
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
  /** Chooses the marked entry or the one at `index`. An unavailable entry, or any while a command runs, does nothing. */
  const choose = (index = active()) => {
    const item = ordered()[index];
    if (!item || item.disabled || status()?.state === "running") return;
    if (item.next) changeStep([...steps(), item]);
    else if (item.text !== undefined) options.onText(item);
    else run(item, steps());
  };
  const changeStep = (next: readonly CommandItem[]) => {
    setSteps(next);
    setWanted(undefined);
    options.onStep?.(next.length);
  };
  // Enter while entries load waits for that query's entries and takes the first that can be chosen; a new query or no
  // match chooses nothing.
  const [awaiting, setAwaiting] = createSignal<string>();
  createEffect(() => {
    const query = awaiting();
    if (query === undefined) return;
    if (query !== options.query()) return setAwaiting(undefined);
    const state = load().state;
    if (state === "loading") return;
    setAwaiting(undefined);
    if (state !== "ready") return;
    const index = ordered().findIndex((item) => !item.disabled);
    if (index >= 0) untrack(() => choose(index));
  });

  return {
    query: options.query,
    step,
    groups,
    entries: ordered,
    active,
    setActive,
    /** Marks the next or previous entry, wrapping; unavailable entries are passed over, as in a searchable menu. */
    move: (delta: 1 | -1) => setActive(nextEnabled(active(), delta)),
    edge: (which: "first" | "last") => setActive(which === "first" ? nextEnabled(-1, 1) : nextEnabled(ordered().length, -1)),
    status,
    load,
    /** Asks a source whose promise failed again. */
    retry: () => setRetries((value) => value + 1),
    /** Whether a command's promise is pending; the list then waits for it. */
    busy: () => status()?.state === "running",
    choose: (index?: number) => choose(index),
    /** Enter while entries load: chooses the first entry of this query once it arrives. */
    chooseWhenLoaded: () => setAwaiting(options.query()),
    /** Whether a choice waits for entries on their way. */
    awaitingChoice: () => awaiting() !== undefined,
    /** Stops a running command: its signal aborts, and its result no longer reaches the list. */
    abort: () => {
      running?.abort();
      running = undefined;
      setStatus(undefined);
      if (outcome()?.state === "running") clearOutcome();
    },
    /** What the last command reported, shown in the list's place until it clears. */
    outcome,
    /** The person typed on: the outcome clears, but not before it showed for `COMMAND_OUTCOME_MIN_MS`. */
    typedOn: () => {
      const current = outcome();
      if (!current || current.state === "running") return;
      const left = COMMAND_OUTCOME_MIN_MS - (Date.now() - shownAt);
      if (left <= 0) return clearOutcome();
      clearTimeout(outcomeTimer);
      outcomeTimer = setTimeout(clearOutcome, left);
    },
    /** Clears the outcome at once, for Escape or a new list; a retry still running is stopped. */
    clearOutcome: () => {
      if (outcome()?.state === "running") {
        running?.abort();
        running = undefined;
      }
      clearOutcome();
    },
    /** Leaves the second list; `false` when the first list shows. */
    back: () => {
      if (steps().length === 0) return false;
      changeStep(steps().slice(0, -1));
      return true;
    },
    /**
     * Forgets steps, mark, and status. A running command goes on, but its result no longer reaches the list, so a
     * retry's running line goes too; a reported outcome stays until it clears.
     */
    reset: () => {
      if (outcome()?.state === "running") clearOutcome();
      running = undefined;
      pending?.abort();
      pending = undefined;
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
  /** Runs after Retry or Close on an outcome, so the host puts the focus back where the person writes. */
  onOutcomeAction?: () => void;
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
    return current?.state === "running" ? commandMessages().running({ label: current.label }) : "";
  };
  const loadFailure = () => {
    const current = nav.load();
    return current.state === "failed" ? (current.message ?? commandMessages().loadFailed) : "";
  };
  /** The outcome as one line of text: the report, or for an error without one, that it did not work. */
  const outcomeText = (outcome: CommandOutcome) =>
    outcome.state === "running"
      ? commandMessages().running({ label: outcome.message })
      : (outcome.message ?? (outcome.state === "error" ? commandMessages().failed : commandMessages().done));
  const outcomeError = () => {
    const current = nav.outcome();
    return current?.state === "error" ? outcomeText(current) : "";
  };
  const status = () => {
    const current = nav.outcome();
    if (current) return current.state === "error" ? "" : outcomeText(current);
    if (runningLabel()) return runningLabel();
    const step = nav.step()?.next;
    const count = props.query().trim() || step ? messages().searchMatches({ count: matches() }) : "";
    return step && count ? `${step.label}, ${count}` : count;
  };

  return (
    <>
      {/* After a command reported, a status line of the same width takes the list's place until it clears. */}
      <Show when={!nav.outcome()} fallback={<CommandOutcomeLine navigator={nav} text={outcomeText} onAction={props.onOutcomeAction} />}>
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
        <div
          id={props.id}
          role="listbox"
          aria-label={nav.step()?.next?.label ?? props.label}
          aria-busy={nav.load().state === "loading" ? "true" : undefined}
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
                        {/* One line: the label, then quietly the reason it is unavailable, or what it does. */}
                        <span class="k2b-dropdown__copy k2b-command-list__text">
                          <span>{entry.item.label}</span>
                          <Show when={entry.item.disabled ?? entry.item.description}>
                            {(text) => <small class="k2b-command-list__description">{text()}</small>}
                          </Show>
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
          <Show when={nav.entries().length === 0 && nav.load().state === "ready"}>
            <p class="k2b-dropdown__empty">{messages().noResults}</p>
          </Show>
          {/* Entries on their way keep the previous ones in place; the state takes one row at the end. */}
          <Show when={nav.load().state === "loading"}>
            <p class="k2b-command-list__state">
              <i class="ti ti-loader-2 k2b-spin" aria-hidden="true" />
              <span>{nav.awaitingChoice() ? commandMessages().loadingChoice : commandMessages().loading}</span>
            </p>
          </Show>
          <Show when={nav.load().state === "failed" ? (nav.load() as { message?: string }) : undefined}>
            {(failed) => (
              <p class="k2b-command-list__state" data-error="">
                <i class="ti ti-alert-circle" aria-hidden="true" />
                <span>{failed().message ?? commandMessages().loadFailed}</span>
                <button type="button" tabIndex={-1} onMouseDown={(event) => event.preventDefault()} onClick={() => nav.retry()}>
                  {messages().retry}
                </button>
              </p>
            )}
          </Show>
        </div>
      </Show>
      {/* Announced once, when the text changes: a confirmation politely, an error at once. */}
      <span class="k2b-sr-only" role="status">
        {status()}
      </span>
      <span class="k2b-sr-only" role="alert">
        {outcomeError() || loadFailure()}
      </span>
    </>
  );
}

/**
 * A command's outcome in the list's place, one line: a confirmation in the status green, an error in the status red
 * with Retry when the command threw or rejected, or a retry running. The live regions of the list announce its text,
 * so the text is hidden here; its buttons are ordinary buttons, since the list it replaced is gone.
 */
function CommandOutcomeLine(props: {
  navigator: CommandNavigator;
  text: (outcome: CommandOutcome) => string;
  onAction?: () => void;
}): JSX.Element {
  const messages = useUiMessages();
  const outcome = () => props.navigator.outcome();
  return (
    <Show when={outcome()}>
      {(current) => (
        // biome-ignore lint/a11y/noStaticElementInteractions: it holds the focus only when a menu without a target has nowhere else to keep it.
        <div
          class="k2b-command-outcome"
          data-state={current().state}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === "Tab") {
              // Tab moves between Retry and Close inside the line; only leaving it reaches the menu, which closes.
              const buttons = Array.from(event.currentTarget.querySelectorAll("button"));
              const next = buttons.indexOf(document.activeElement as HTMLButtonElement) + (event.shiftKey ? -1 : 1);
              if (next >= 0 && next < buttons.length) event.stopPropagation();
              return;
            }
            // Keys on the outcome itself are the person moving on, as typing in the text is.
            if (event.target === event.currentTarget && !["Escape", "Shift"].includes(event.key)) props.navigator.typedOn();
          }}
        >
          <i
            aria-hidden="true"
            class={
              current().state === "success"
                ? "ti ti-circle-check"
                : current().state === "error"
                  ? "ti ti-alert-circle"
                  : "ti ti-loader-2 k2b-spin"
            }
          />
          <span class="k2b-command-outcome__text" title={props.text(current())} aria-hidden="true">
            {props.text(current())}
          </span>
          <Show when={current().state === "error" ? (current() as { retry?: () => void }).retry : undefined}>
            {(retry) => (
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  retry()();
                  props.onAction?.();
                }}
              >
                {messages().retry}
              </button>
            )}
          </Show>
          <Show when={current().state === "error"}>
            <button
              type="button"
              class="k2b-command-outcome__close"
              aria-label={messages().close}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                props.navigator.clearOutcome();
                props.onAction?.();
              }}
            >
              <i class="ti ti-x" aria-hidden="true" />
            </button>
          </Show>
        </div>
      )}
    </Show>
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
      // Enter while entries load takes the first entry of exactly this query once it arrives, never a stale one.
      if (event.key === "Enter" && !event.shiftKey && nav.load().state === "loading") {
        nav.chooseWhenLoaded();
        return true;
      }
      // Enter asks a list that could not load again.
      if (event.key === "Enter" && !event.shiftKey && nav.load().state === "failed" && nav.entries().length === 0) {
        nav.retry();
        return true;
      }
      if (event.shiftKey || nav.entries().length === 0) return false;
      nav.choose();
      return true;
    case "Escape":
      // A running command is stopped by the host, before any back.
      if (nav.busy()) return false;
      return nav.back();
    case "Backspace":
      return query === "" && nav.back();
    default:
      return false;
  }
};
