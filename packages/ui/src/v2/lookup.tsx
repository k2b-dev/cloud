import { createEffect, createMemo, createSignal, createUniqueId, For, on, onCleanup, Show, untrack } from "solid-js";
import { isServer } from "solid-js/web";
import { createAsyncOptions } from "./behavior/async-options";
import { useCommand } from "./behavior/command";
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
  /**
   * The sentence a failed load shows, from the app's own catalog, for what its server answered (a message or a code
   * the app reads off the error `load` threw); "Konnte nicht geladen werden. Deine Auswahl bleibt." when it gives none.
   * "Erneut versuchen" stays beside it.
   */
  failure?: (error: unknown) => string | undefined;
};

/** How long typing must pause before a search loads, and how long a load may run before its placeholders show. */
export const lookupTiming = { debounce: 200, placeholder: 150 } as const;

type Phase = "idle" | "loading" | "done" | "error";

/**
 * Values that are loaded while the person types, the panel of a filter: a search over a list that stays open (core's
 * command, no popup) and chooses several (a box first) or one (`multiple={false}`, a tick at the end). Typing waits
 * 200 ms, then loads; a newer search and closing abort the one that runs (core's async options, `AbortSignal`). A
 * load that takes longer than 150 ms shows three placeholder rows; empty and failed take the same height, so nothing
 * jumps. What is chosen stands on top under "Gewählt" in every state. The focus stays in the search while the arrows
 * move the highlight; Enter or a press ticks the highlighted entry.
 */
export const Lookup = (props: LookupProps) => {
  const t = useFilterMessages();
  const limit = () => Math.min(Math.max(props.limit ?? 8, 1), 50);
  const [query, setQuery] = createSignal("");
  const [slow, setSlow] = createSignal(false);
  const [counts, setCounts] = createSignal<Readonly<Record<string, number>>>({});
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

  // Core loads: it waits while the person types, aborts a load a newer one replaces, and keeps the status. The counts
  // come with a load's answer and are kept only from the answer that counts.
  const options = createAsyncOptions<LookupItem>(
    async (text, context) => {
      const result = await props.load(text, { signal: context.signal, limit: limit() });
      if (!context.signal.aborted) setCounts(result.counts ?? {});
      return result.items.slice(0, limit());
    },
    { debounce: lookupTiming.debounce, immediate: !isServer && (props.minChars ?? 0) === 0, minLength: props.minChars ?? 0 },
  );
  const [state, setState] = createSignal(options.getState());
  onCleanup(options.subscribe(() => setState(options.getState())));
  onCleanup(() => options.cancel());
  const items = () => state().items;
  // what the shown matches are for, and whether any search has answered yet
  const [loadedFor, setLoadedFor] = createSignal("");
  const [answered, setAnswered] = createSignal(false);
  const phase = (): Phase => {
    const now = state();
    if (now.status === "loading") return "loading";
    if (now.status === "error") return "error";
    return answered() ? "done" : "idle";
  };
  // Placeholders show only once a load runs longer than 150 ms; while typing, the load starts after the 200 ms wait.
  createEffect(
    on(
      () => state().status,
      (status) => {
        setSlow(false);
        if (status === "loading") {
          const timer = setTimeout(() => setSlow(true), (answered() ? lookupTiming.debounce : 0) + lookupTiming.placeholder);
          onCleanup(() => clearTimeout(timer));
          return;
        }
        if (status === "idle" && state().query.trim().length >= (props.minChars ?? 0)) {
          remember(state().items);
          setLoadedFor(state().query);
          setAnswered(true);
        }
        if (status === "error") setLoadedFor(state().query);
      },
    ),
  );
  const search = (text: string) => {
    setQuery(text);
    options.setQuery(text.trim());
  };

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
  const showList = () => phase() === "done" || (phase() === "loading" && !slow() && answered());

  const several = () => props.multiple !== false;
  // Core's command: the focus stays in the search, the arrows move the highlight (aria-activedescendant), Enter or a
  // press runs the highlighted entry. What is chosen is ours: core's value is only the highlighted entry.
  const choose = (code: string) => {
    if (!several()) return props.onChange(props.value.includes(code) ? [...props.value] : [code]);
    props.onChange(props.value.includes(code) ? props.value.filter((value) => value !== code) : [...props.value, code]);
  };
  const list = useCommand(() => ({
    query: query(),
    onQueryChange: search,
    onAction: choose,
    filter: false,
    status: state().status,
    loop: false,
  }));

  // core names a group by its label through the group's id, which a label is handed here (no renderer context does it)
  const chosenGroup = createUniqueId();
  const offeredGroup = createUniqueId();

  const Option = (item: LookupItem) => (
    <list.Item class="k2-opt" value={item.value} label={item.label} aria-checked={props.value.includes(item.value) ? "true" : "false"}>
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
    <list.Root class="k2-lookup" data-k2-part="Lookup">
      <div class="k2-input k2-lookup-search" data-search="">
        <Icon name="search" />
        <list.Input aria-label={t().search({ field: props.label })} spellcheck={false} />
      </div>
      <list.List class="k2-lookup-list" aria-label={props.label}>
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
      </list.List>
      <Show when={!(showList() && offered().length > 0)}>
        <div class="k2-lookup-state">
          <Show when={phase() === "error"}>
            <Failed text={props.failure?.(state().error) ?? t().loadFailed} onRetry={() => options.reload()} />
          </Show>
          <Show when={phase() === "done" && offered().length === 0}>
            <Empty icon="search-off" text={loadedFor() ? t().noMatch({ query: loadedFor() }) : t().noValues} />
          </Show>
          <Show when={phase() === "loading" || phase() === "idle"}>
            <div class="k2-lookup-skel" aria-hidden="true" data-shown={slow() ? "" : undefined}>
              <span class="k2-skel" />
              <span class="k2-skel" />
              <span class="k2-skel" />
            </div>
          </Show>
        </div>
      </Show>
      <p class="k2-lookup-hint">{t().limitHint({ limit: limit() })}</p>
    </list.Root>
  );
};
