import { createEffect, createMemo, createSignal, createUniqueId, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { useListbox } from "./behavior/lists";
import { useBehaviorMessages } from "./behavior/messages";
import { useFilterMessages } from "./filter-messages";
import type { LookupItem } from "./list-query";
import { Icon } from "./marks";
import { Empty, Failed } from "./states";

/**
 * Loads the values for a search. `signal` aborts when a newer search replaces this one or the lookup closes; pass it
 * to `fetch`. `counts` may say how many entries each value would leave with the other filters.
 */
export type LookupLoad = (
  query: string,
  context: { signal: AbortSignal; limit: number },
) => Promise<{ items: readonly LookupItem[]; counts?: Readonly<Record<string, number>> }>;

/** Names the given codes, such as those a link carries; a code it does not name stays a code with a warning. */
export type LookupResolve = (values: readonly string[], context: { signal: AbortSignal }) => Promise<readonly LookupItem[]>;

export type LookupProps = {
  /** The name of what is looked up, such as "Einlieferer"; the search field is named after it. */
  label: string;
  /** The chosen codes. */
  value: readonly string[];
  /** Every tick applies at once; with one choice it holds the chosen code. */
  onChange: (value: string[]) => void;
  /**
   * `false`: one value, its tick at the end of the row; several by default, each with its box first.
   */
  multiple?: boolean;
  load: LookupLoad;
  resolve?: LookupResolve;
  /** Names the page already knows (the server resolved the codes of the address), so the first picture shows names. */
  known?: readonly LookupItem[];
  /** How many matches one search shows: 8 by default, at most 50. */
  limit?: number;
  /** Characters a search needs before it loads; 0 by default, so an empty search shows the first values. */
  minChars?: number;
};

/** How long typing must pause before a search loads, and how long a load may run before its placeholders show. */
export const lookupTiming = { debounce: 200, placeholder: 150 } as const;

type Phase = "idle" | "waiting" | "loading" | "done" | "error";

/**
 * Values that are loaded while the person types, the panel of a filter and of `LookupSelect`: a search field over a
 * list that chooses several (a box first) or one (`multiple={false}`, a tick at the end). Typing waits 200 ms, then loads; a newer search and closing abort the one that runs (`AbortSignal`). A load
 * that takes longer than 150 ms shows three placeholder rows; empty and failed take the same height, so nothing jumps.
 * What is chosen stands on top under "Gewählt" in every state. The list is the ui-sdk listbox (arrows, Home, End,
 * Space, typeahead); Arrow down in the field moves into it, Arrow up from its first entry back.
 */
export const Lookup = (props: LookupProps) => {
  const t = useFilterMessages();
  const said = useBehaviorMessages();
  const limit = () => Math.min(Math.max(props.limit ?? 8, 1), 50);
  const [query, setQuery] = createSignal("");
  const [phase, setPhase] = createSignal<Phase>("idle");
  const [slow, setSlow] = createSignal(false);
  const [items, setItems] = createSignal<readonly LookupItem[]>([]);
  const [counts, setCounts] = createSignal<Readonly<Record<string, number>>>({});
  const [loadedFor, setLoadedFor] = createSignal("");
  const [answered, setAnswered] = createSignal(false);
  const [names, setNames] = createSignal<ReadonlyMap<string, LookupItem>>(new Map((props.known ?? []).map((item) => [item.value, item])));
  const [missing, setMissing] = createSignal<ReadonlySet<string>>(new Set());
  const remember = (list: readonly LookupItem[]) => {
    if (list.length === 0) return;
    setNames((before) => {
      const next = new Map(before);
      for (const item of list) next.set(item.value, item);
      return next;
    });
  };

  let running: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let slowTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    running?.abort();
    running = undefined;
    clearTimeout(timer);
    clearTimeout(slowTimer);
  };
  onCleanup(stop);

  const run = (text: string) => {
    stop();
    const controller = new AbortController();
    running = controller;
    setPhase("loading");
    slowTimer = setTimeout(() => setSlow(true), lookupTiming.placeholder);
    props.load(text, { signal: controller.signal, limit: limit() }).then(
      (result) => {
        if (controller.signal.aborted) return;
        clearTimeout(slowTimer);
        setSlow(false);
        const list = result.items.slice(0, limit());
        remember(list);
        setItems(list);
        setCounts(result.counts ?? {});
        setLoadedFor(text);
        setAnswered(true);
        setPhase("done");
      },
      () => {
        if (controller.signal.aborted) return;
        clearTimeout(slowTimer);
        setSlow(false);
        setLoadedFor(text);
        setPhase("error");
      },
    );
  };
  const search = (text: string) => {
    setQuery(text);
    stop();
    setSlow(false);
    if (text.trim().length < (props.minChars ?? 0)) {
      setItems([]);
      setPhase("idle");
      return;
    }
    setPhase("waiting");
    timer = setTimeout(() => run(text.trim()), lookupTiming.debounce);
  };
  onMount(() => {
    if ((props.minChars ?? 0) === 0) run("");
  });

  // Codes without a name (from a link) are named once; a code the app cannot name stays a code with a warning and is
  // not asked for again while this lookup is open.
  const asked = new Set<string>();
  createEffect(
    on(
      () => props.value.filter((value) => !untrack(names).has(value) && !asked.has(value)),
      (unknown) => {
        for (const value of unknown) asked.add(value);
        const resolve = props.resolve;
        if (unknown.length === 0 || !resolve) return;
        const controller = new AbortController();
        onCleanup(() => controller.abort());
        resolve(unknown, { signal: controller.signal }).then(
          (found) => {
            if (controller.signal.aborted) return;
            remember(found);
            const named = new Set(found.map((item) => item.value));
            setMissing(new Set(unknown.filter((value) => !named.has(value))));
          },
          () => undefined,
        );
      },
    ),
  );

  const chosen = createMemo(() => props.value.map((value) => names().get(value) ?? { value, label: value }));
  const offered = createMemo(() => items().filter((item) => !props.value.includes(item.value)));
  // the last matches stay while the next search waits and loads, until its placeholders show (150 ms into the load)
  const showList = () => phase() === "done" || ((phase() === "loading" || phase() === "waiting") && !slow() && answered());

  const several = () => props.multiple !== false;
  const list = useListbox(() => ({
    multiple: several(),
    value: several() ? [...props.value] : (props.value[0] ?? null),
    // the arrows only move; a press, Space or Enter chooses (one choice then closes the field that holds the list)
    activation: "manual",
    loop: false,
    onValueChange: (value) => props.onChange(Array.isArray(value) ? value : value ? [value] : []),
  }));

  const [listId, setListId] = createSignal<string>();
  // core names a group by its label through the group's id, which a label is handed here (no renderer context does it)
  const chosenGroup = createUniqueId();
  const offeredGroup = createUniqueId();
  let field: HTMLInputElement | undefined;
  let box: HTMLDivElement | undefined;
  const focusList = () => {
    const target = box?.querySelector<HTMLElement>('[role="option"][tabindex="0"]') ?? box?.querySelector<HTMLElement>('[role="option"]');
    target?.focus();
  };
  const announcement = () => {
    if (phase() === "loading" && slow()) return said().loading;
    if (phase() !== "done") return "";
    return offered().length ? said().listResults({ count: offered().length }) : said().listEmpty;
  };

  const Option = (item: LookupItem) => (
    <list.Item class="k2-opt" value={item.value} label={item.label}>
      <Show when={several()}>
        <span class="k2-check" data-checked={props.value.includes(item.value) ? "" : undefined} aria-hidden="true">
          <Show when={props.value.includes(item.value)}>
            <Icon name="check" />
          </Show>
        </span>
      </Show>
      <span class="k2-opt-label">
        {item.label}
        <Show when={item.meta}>{(meta) => <span class="k2-opt-meta">{meta()}</span>}</Show>
      </span>
      <Show when={missing().has(item.value)}>
        <span class="k2-opt-warn" title={t().unknownValue}>
          <Icon name="alert-triangle" label={t().unknownValue} />
        </span>
      </Show>
      <Show when={counts()[item.value] !== undefined}>
        <span class="k2-opt-count">{counts()[item.value]}</span>
      </Show>
      <Show when={!several()}>
        <span class="k2-opt-tick" aria-hidden="true">
          <Show when={props.value.includes(item.value)}>
            <Icon name="check" />
          </Show>
        </span>
      </Show>
    </list.Item>
  );

  return (
    <div class="k2-lookup" data-k2-part="Lookup">
      <div class="k2-input k2-lookup-search" data-search="">
        <Icon name="search" />
        <input
          ref={field}
          type="search"
          aria-label={t().search({ field: props.label })}
          aria-controls={listId()}
          autocomplete="off"
          spellcheck={false}
          value={query()}
          onInput={(event) => search(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              focusList();
            }
          }}
        />
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the keys come up from the listbox's options; the box takes no focus. */}
      <div
        ref={box}
        onKeyDown={(event) => {
          // Arrow up from the first entry goes back to the search, where typing goes on
          if (event.key !== "ArrowUp") return;
          // the listbox moves the focus before the key reaches this box, so the option the key was pressed on is
          // the event's target, not the focused element
          const options = [...(box?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
          if (options[0] && event.target === options[0]) {
            event.preventDefault();
            field?.focus();
          }
        }}
      >
        <list.Root
          ref={(element: HTMLElement) => queueMicrotask(() => setListId(element.id || undefined))}
          class="k2-lookup-list"
          aria-label={props.label}
          aria-busy={phase() === "loading" ? "true" : undefined}
        >
          <Show when={chosen().length > 0}>
            <list.Group class="k2-opt-group" id={chosenGroup}>
              <list.GroupLabel class="k2-opt-head" id={chosenGroup} group={chosenGroup}>
                {t().chosen}
              </list.GroupLabel>
              <For each={chosen()}>{Option}</For>
            </list.Group>
          </Show>
          <list.Group class="k2-opt-group" id={offeredGroup}>
            <list.GroupLabel class="k2-opt-head" id={offeredGroup} group={offeredGroup}>
              {loadedFor() && showList() ? t().resultsFor({ query: loadedFor() }) : t().results}
            </list.GroupLabel>
            <Show when={showList() && offered().length > 0}>
              <For each={offered()}>{Option}</For>
            </Show>
          </list.Group>
        </list.Root>
        <Show when={!(showList() && offered().length > 0)}>
          <div class="k2-lookup-state">
            <Show when={phase() === "error"}>
              <Failed text={t().loadFailed} onRetry={() => run(query().trim())} />
            </Show>
            <Show when={phase() === "done" && offered().length === 0}>
              <Empty icon="search-off" text={loadedFor() ? t().noMatch({ query: loadedFor() }) : t().noValues} />
            </Show>
            <Show when={phase() === "loading" || phase() === "waiting" || phase() === "idle"}>
              <div class="k2-lookup-skel" aria-hidden="true" data-shown={slow() ? "" : undefined}>
                <span class="k2-skel" />
                <span class="k2-skel" />
                <span class="k2-skel" />
              </div>
            </Show>
          </div>
        </Show>
      </div>
      <p class="k2-lookup-hint">{t().limitHint({ limit: limit() })}</p>
      <span class="k2-hidden-text" aria-live="polite">
        {announcement()}
      </span>
    </div>
  );
};
