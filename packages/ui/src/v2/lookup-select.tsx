import { createSignal, createUniqueId, For, onCleanup, onMount, Show } from "solid-js";
import { createAsyncOptions } from "./behavior/async-options";
import { useBehaviorMessages } from "./behavior/messages";
import { type ChoiceItem, useSelect } from "./behavior/select";
import { useField } from "./controls";
import { useFilterMessages } from "./filter-messages";
import type { LookupItem } from "./list-query";
import { type LookupLoad, type LookupResolve, lookupTiming } from "./lookup";
import { Icon } from "./marks";
import { Empty, Failed } from "./states";

type LookupSelectCommon = {
  /** The app's own search, with its own access checks; pass `signal` to `fetch` (see `Lookup`). */
  load: LookupLoad;
  /** Names codes the page does not know yet, such as a value the form starts with; runs once in the browser. */
  resolve?: LookupResolve;
  /** Names the server already knows for the value, so the first picture (server and browser alike) shows names. */
  known?: readonly LookupItem[];
  /** How many matches one search shows: 8 by default, at most 50. */
  limit?: number;
  /** Characters a search needs before it loads; 0 by default. */
  minChars?: number;
  /**
   * The sentence a failed load shows, from the app's own catalog, for what its server answered (a message or a code
   * the app reads off the error `load` threw); "Konnte nicht geladen werden. Deine Auswahl bleibt." when it gives none.
   * "Erneut versuchen" stays beside it.
   */
  failure?: (error: unknown) => string | undefined;
  /** The quiet words of the closed field while nothing is chosen, such as "Kunde wählen". */
  placeholder?: string;
  /** The name each chosen code is sent under in a form; the field's name by default. */
  name?: string;
  /** A name for the field when it stands without a `Field`. */
  label?: string;
  /** The value cannot be changed now. */
  disabled?: boolean;
};

export type LookupSelectProps = LookupSelectCommon &
  (
    | {
        /** One value (the default): choosing it closes the list. */
        multiple?: false;
        value?: string;
        onChange: (value: string | undefined) => void;
      }
    | {
        /** Several values: each press ticks or unticks, the list stays open until it is left. */
        multiple: true;
        value: readonly string[];
        onChange: (value: string[]) => void;
      }
  );

/**
 * A form field that chooses from values the app loads while the person types, such as a customer of 412 or a person:
 * core's select with a search field in its list. Closed it shows the chosen names like `Select`; open, the search
 * (200 ms wait, a newer search aborts the older, placeholders, empty, failed with retry) over the matches, under the
 * field or, on a small touch screen, as a sheet from the bottom. In a `Field` it takes the field's label, name, hint,
 * error and `required`; core's form input sends each chosen code, blocks an empty required send, follows a form's
 * reset and leaves a disabled field out. The names come from `known` (resolved on the server) and from what loads, so
 * the server and the first picture in the browser agree; codes without a name are resolved once in the browser.
 */
export const LookupSelect = (props: LookupSelectProps) => {
  const field = useField();
  const t = useFilterMessages();
  const said = useBehaviorMessages();
  const nameId = createUniqueId();
  let trigger: HTMLElement | undefined;
  field?.named(() => trigger?.focus());
  const limit = () => Math.min(Math.max(props.limit ?? 8, 1), 50);

  const chosen = (): readonly string[] =>
    props.multiple ? props.value : props.value === undefined || props.value === "" ? [] : [props.value];
  const [names, setNames] = createSignal<ReadonlyMap<string, LookupItem>>(new Map((props.known ?? []).map((item) => [item.value, item])));
  const remember = (items: readonly LookupItem[]) => {
    const fresh = items.filter((item) => names().get(item.value)?.label !== item.label);
    if (fresh.length === 0) return;
    setNames((before) => new Map([...before, ...fresh.map((item) => [item.value, item] as const)]));
  };
  const labelOf = (code: string) => names().get(code)?.label ?? code;

  // Codes the page could not name: asked for once, after the first picture, so the server and the browser agree on it.
  onMount(() => {
    const resolve = props.resolve;
    const unknown = chosen().filter((code) => !names().has(code));
    if (!resolve || unknown.length === 0) return;
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    resolve(unknown, { signal: controller.signal }).then(
      (found) => !controller.signal.aborted && remember(found),
      () => undefined,
    );
  });

  // Core loads: the wait while typing, the abort of a search a newer one replaces, the status. Names are kept only
  // from an answer that still counts, so a late answer of an aborted search renames nothing.
  const options = createAsyncOptions<LookupItem>(
    async (text, context) => {
      const result = await props.load(text, { signal: context.signal, limit: limit() });
      const items = result.items.slice(0, limit());
      if (!context.signal.aborted) remember(items);
      return items;
    },
    { debounce: lookupTiming.debounce, minLength: props.minChars ?? 0 },
  );
  const [state, setState] = createSignal(options.getState());
  onCleanup(options.subscribe(() => setState(options.getState())));
  onCleanup(() => options.cancel());
  const items = (): ChoiceItem[] => state().items.map((item) => ({ value: item.value, label: item.label }));
  const metaOf = (code: string) => state().items.find((item) => item.value === code)?.meta;

  const [open, setOpen] = createSignal(false);
  // One value that may stay empty can be taken back: "Auswahl entfernen" under the matches.
  const clearable = () => !props.multiple && !field?.required && !props.disabled && chosen().length > 0;
  const shared = () => ({
    items: items(),
    filter: false as const,
    status: state().status,
    onQueryChange: (query: string) => options.setQuery(query.trim()),
    open: open(),
    onOpenChange: (open: boolean) => {
      setOpen(open);
      // the first matches load as the list opens, without the wait for typing
      if (open && (props.minChars ?? 0) === 0) options.reload();
      if (!open) options.cancel();
    },
    itemToLabel: labelOf,
    presentation: "auto" as const,
    disabled: props.disabled,
    required: field?.required && !props.disabled,
    placeholder: props.placeholder,
    name: props.name ?? field?.name,
  });
  const select = useSelect(() =>
    props.multiple
      ? {
          ...shared(),
          multiple: true as const,
          value: [...chosen()],
          onValueChange: (next: string[]) => (props.onChange as (value: string[]) => void)(next),
        }
      : {
          ...shared(),
          value: chosen()[0] ?? null,
          onValueChange: (next: string | null) => (props.onChange as (value: string | undefined) => void)(next ?? undefined),
        },
  );

  return (
    <>
      <select.Trigger
        ref={(element: HTMLElement) => {
          trigger = element;
        }}
        class="k2-input"
        data-k2-part="LookupSelect"
        data-select=""
        data-invalid={field?.invalid ? "" : undefined}
        aria-labelledby={field?.label ?? nameId}
        aria-describedby={field?.described}
        aria-invalid={field?.invalid ? "true" : undefined}
        title={chosen().length > 1 ? chosen().map(labelOf).join(", ") : undefined}
      >
        <Show when={!field}>
          <span class="k2-hidden-text" id={nameId}>
            {props.label}
          </span>
        </Show>
        <span class="k2-input-value" data-placeholder={chosen().length === 0 ? "" : undefined}>
          {chosen().length > 0 ? chosen().map(labelOf).join(", ") : (props.placeholder ?? "")}
        </span>
        <Icon name="chevron-down" />
      </select.Trigger>
      {/* core's form input: each chosen code under the field's name, required, reset with the form, out when disabled */}
      <select.FormInput />
      <Show when={props.multiple}>
        <For each={[...chosen()]}>{(code) => <select.ValueInput value={code} />}</For>
      </Show>
      <select.Popup
        class="k2-menu k2-lpick"
        data-listbox=""
        sideOffset={4}
        collisionPadding={8}
        head={
          <span class="k2-input k2-lookup-search" data-search="">
            <Icon name="search" />
            <select.Input aria-label={t().search({ field: field?.text ?? props.label ?? "" })} />
          </span>
        }
        option={(item: ChoiceItem) => (
          <select.Item class="k2-mi" value={item.value} label={item.label}>
            <Show when={props.multiple}>
              <span class="k2-check" data-checked={chosen().includes(item.value) ? "" : undefined} aria-hidden="true">
                <Show when={chosen().includes(item.value)}>
                  <Icon name="check" />
                </Show>
              </span>
            </Show>
            <span class="k2-mi-label">
              {item.label}
              <Show when={metaOf(item.value)}>{(meta) => <span class="k2-opt-meta">{meta()}</span>}</Show>
            </span>
            <Show when={!props.multiple}>
              {/* one choice: the tick at the end of the row */}
              <span class="k2-mi-tick">
                <select.ItemIndicator item={item.value}>
                  <Icon name="check" />
                </select.ItemIndicator>
              </span>
            </Show>
          </select.Item>
        )}
      >
        <select.Status class="k2-lpick-state">
          {(now: { status?: string }) => (
            <Show
              when={now.status === "error"}
              fallback={<Show when={now.status === "loading" && state().items.length === 0}>{said().loading}</Show>}
            >
              <Failed text={props.failure?.(state().error) ?? t().loadFailed} onRetry={() => options.reload()} />
            </Show>
          )}
        </select.Status>
        <select.Empty class="k2-lpick-state">
          <Show when={state().status === "idle"}>
            <Empty icon="search-off" text={state().query ? t().noMatch({ query: state().query }) : t().noValues} />
          </Show>
        </select.Empty>
        <Show when={clearable()}>
          {/* taking the value back is a choice too: the list closes after it */}
          <select.Clear class="k2-btn k2-lpick-clear" data-variant="text" onClick={() => queueMicrotask(() => setOpen(false))}>
            <Icon name="x" />
            <span class="k2-btn-label">{t().clearChoice}</span>
          </select.Clear>
        </Show>
      </select.Popup>
    </>
  );
};
