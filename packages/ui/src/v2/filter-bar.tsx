import { createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { isServer } from "solid-js/web";
import { useLocale } from "../intl/locale";
import { useListbox } from "./behavior/lists";
import { usePopover } from "./behavior/overlays";
import { Button } from "./button";
import { Field, Input } from "./controls";
import { type FilterMessages, useFilterMessages } from "./filter-messages";
import type {
  ListQuery,
  ListQueryField,
  ListQueryOption,
  ListQueryState,
  LookupItem,
  NumberRange,
  PeriodValue,
  SavedListView,
  ViewStore,
} from "./list-query";
import { Lookup } from "./lookup";
import { Icon } from "./marks";
import { Menu, type MenuEntry, type MenuItem } from "./menu";
import { Dialog } from "./overlays";
import { useToast } from "./toast";

// ── Reading a state ────────────────────────────────────────────────────────────────────────────────────────────

type Fields = Record<string, ListQueryField>;

/** One part of a statement: plain grammar, or a value in the app's ink. */
type Part = { text: string; value?: boolean; missing?: boolean };

const isRange = (value: unknown): value is NumberRange =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !("kind" in value);
const isPeriod = (value: unknown): value is PeriodValue =>
  typeof value === "object" && value !== null && "kind" in value && (value.kind === "preset" || value.kind === "range");
const codes = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : typeof value === "string" ? [value] : [];

/** The URL text of a value, in the address format of `defineListQuery`; `undefined` clears the field. */
const encode = (definition: ListQueryField, value: unknown): string | undefined => {
  switch (definition.kind) {
    case "choice":
    case "lookup": {
      const list = codes(value);
      return list.length ? list.join(",") : undefined;
    }
    case "numberRange":
      return isRange(value) && (value.min !== undefined || value.max !== undefined) ? `${value.min ?? ""}..${value.max ?? ""}` : undefined;
    case "dateRange":
    case "timeRange":
      if (!isPeriod(value)) return undefined;
      if (value.kind === "preset") return value.preset;
      return value.from || value.to ? `${value.from ?? ""}..${value.to ?? ""}` : undefined;
    case "bool":
      return typeof value === "boolean" ? (value ? "yes" : "no") : undefined;
    case "text":
      return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }
};

const labelOf = (options: readonly ListQueryOption[], code: string) => options.find((option) => option.value === code)?.label ?? code;

/** "A", "A oder B", "A, B oder C", and above three values "A, B oder 2 weitere". */
const listParts = (labels: readonly { text: string; missing?: boolean }[], t: FilterMessages): Part[] => {
  const shown = labels.length > 3 ? labels.slice(0, 2) : labels;
  const parts: Part[] = [];
  shown.forEach((label, index) => {
    if (index > 0) parts.push({ text: index === shown.length - 1 && labels.length <= 3 ? ` ${t.or} ` : ", " });
    parts.push({ text: label.text, value: true, missing: label.missing });
  });
  if (labels.length > 3) parts.push({ text: ` ${t.or} ` }, { text: t.moreValues({ count: labels.length - 2 }), value: true });
  return parts;
};

type Formats = { number: (value: number) => string; day: (text: string) => string; minute: (text: string) => string };

const useFormats = (): (() => Formats) => {
  const locale = useLocale();
  return createMemo(() => {
    const number = new Intl.NumberFormat(locale());
    const day = new Intl.DateTimeFormat(locale(), { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
    const minute = new Intl.DateTimeFormat(locale(), { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    return {
      number: (value: number) => number.format(value),
      day: (text: string) => {
        const date = new Date(`${text}T00:00:00Z`);
        return Number.isNaN(date.getTime()) ? text : day.format(date);
      },
      minute: (text: string) => {
        const date = new Date(text.replace(/Z$/, ":00Z"));
        return Number.isNaN(date.getTime()) ? text : minute.format(date);
      },
    };
  });
};

/** The value words of a field, without its name: "Eingeliefert oder Fotografiert", "ab 500 €". */
const valueParts = (
  definition: ListQueryField,
  value: unknown,
  t: FilterMessages,
  format: Formats,
  names: ReadonlyMap<string, LookupItem>,
): Part[] => {
  switch (definition.kind) {
    case "choice":
      return listParts(
        codes(value).map((code) => ({ text: labelOf(definition.options, code) })),
        t,
      );
    case "lookup":
      return listParts(
        codes(value).map((code) => {
          const named = names.get(code);
          return named ? { text: named.label } : { text: code, missing: true };
        }),
        t,
      );
    case "numberRange": {
      if (!isRange(value)) return [];
      const unit = definition.unit ? ` ${definition.unit}` : "";
      const show = (amount: number) => `${format.number(amount)}${unit}`;
      if (value.min !== undefined && value.max !== undefined)
        return [{ text: t.between({ min: show(value.min), max: show(value.max) }), value: true }];
      if (value.min !== undefined) return [{ text: `${t.from} ${show(value.min)}`, value: true }];
      if (value.max !== undefined) return [{ text: `${t.upTo} ${show(value.max)}`, value: true }];
      return [];
    }
    case "dateRange":
    case "timeRange": {
      if (!isPeriod(value)) return [];
      if (value.kind === "preset") return [{ text: labelOf(definition.presets, value.preset), value: true }];
      const show = definition.kind === "dateRange" ? format.day : format.minute;
      if (value.from && value.to) {
        return [
          { text: value.from === value.to ? show(value.from) : t.between({ min: show(value.from), max: show(value.to) }), value: true },
        ];
      }
      if (value.from) return [{ text: `${t.from} ${show(value.from)}`, value: true }];
      if (value.to) return [{ text: `${t.upTo} ${show(value.to)}`, value: true }];
      return [];
    }
    case "bool":
      return typeof value === "boolean" ? [{ text: value ? definition.labels.yes : definition.labels.no, value: true }] : [];
    case "text":
      return typeof value === "string" ? [{ text: value, value: true }] : [];
  }
};

/** Whether a field's sentence says "ist" before its values; ranges and periods carry their own words. */
const saysIs = (definition: ListQueryField) =>
  definition.kind === "choice" || definition.kind === "lookup" || definition.kind === "bool" || definition.kind === "text";

/** The whole statement: "Status ist Eingeliefert oder Fotografiert", "Preis ab 500 €", "Zeitraum letzte 15 Minuten". */
const statementParts = (definition: ListQueryField, values: Part[], t: FilterMessages): Part[] => [
  { text: `${definition.label} ` },
  ...(saysIs(definition) ? [{ text: `${definition.op ?? t.is} ` }] : definition.op ? [{ text: `${definition.op} ` }] : []),
  ...values,
];

const plain = (parts: readonly Part[]) => parts.map((part) => part.text).join("");

// ── The address ────────────────────────────────────────────────────────────────────────────────────────────────

/** The query parameters of a state, without the view it started from: two states are equal when these are. */
const stateText = <F extends Fields, S extends string, G extends string>(query: ListQuery<F, S, G>, state: ListQueryState<F, S, G>) => {
  const params = query.serialize(state);
  params.delete("view");
  return params.toString();
};

/** The phone of v2: every width below 768 px. */
const phoneQuery = "not all and (min-width: 768px)";
const isPhone = () => !isServer && matchMedia(phoneQuery).matches;

// ── FilterBar ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Where saved views come from and go to; leave it out and the bar offers no saving. */
export type FilterBarViews = {
  /**
   * The stores the app offers, in the order the dialog lists them. A store the person may not write appears only when
   * another can be written (it is named, locked, with the reason). With one writable store the dialog asks no scope.
   */
  stores: readonly ViewStore[];
  /** The view the state started from, when it is a saved one or one in code (`scope` undefined): its name and store. */
  current?: { key: string; label: string; scope?: ViewStore["scope"] };
  /** After a save, an update, a rename or a delete: the app lists its views again (tabs) and opens the saved one. */
  onSaved?: (view: SavedListView, store: ViewStore) => void;
  onRemoved?: (key: string, store: ViewStore) => void;
};

export type FilterBarProps<F extends Fields, S extends string, G extends string> = {
  /** The declaration from `defineListQuery`, the same one the server parses the address with. */
  query: ListQuery<F, S, G>;
  /** The state the server parsed from the address; the bar is controlled. */
  state: ListQueryState<F, S, G>;
  /**
   * Every change, already written to the address: the app loads the list for it. The bar writes the address itself
   * (each open editor adds one entry to the history, every other change one), and calls this on back and forward too.
   */
  onChange: (state: ListQueryState<F, S, G>) => void;
  /** The state of the current view, which "Zurücksetzen" returns to; the empty query (`query.reset()`) by default. */
  base?: ListQueryState<F, S, G>;
  /** A Tabler icon per field, before its name in "+ Filter" and the phone sheet. */
  icons?: Partial<Record<keyof F & string, string>>;
  /** Counts per value of the fields declared with `counts`, from the server, counted with the other filters. */
  counts?: Partial<Record<keyof F & string, Readonly<Record<string, number>>>>;
  /** Names of lookup values the server resolved (`resolve`) for the codes of the address, so the first picture shows names. */
  names?: readonly LookupItem[];
  /** Saved views; without it there is no "Ansicht ▾" and no saving. */
  views?: FilterBarViews;
  /** What the list shows, such as "9 Artikel": the phone sheet's button reads "9 Artikel zeigen". */
  results?: string;
};

/**
 * The filters of a list as readable statements under its head: "Status ist Eingeliefert oder Fotografiert", "und",
 * "Preis ab 500 €". Each statement opens its editor; "+ Filter" adds one, "Zurücksetzen" returns to the view, "Ansicht
 * ▾" saves. From 768 px the statements flow and wrap between whole statements; on the phone the bar is one line that
 * scrolls sideways and every tap opens the filter sheet. The bar filters nothing itself: it writes the address and
 * tells the app, which loads the list on the server.
 */
export const FilterBar = <F extends Fields, S extends string, G extends string>(props: FilterBarProps<F, S, G>) => {
  const t = useFilterMessages();
  const format = useFormats();
  const fields = createMemo(() => Object.entries(props.query.fields));
  const filters = (): Readonly<Record<string, unknown>> => props.state.filters;
  const base = () => props.base ?? props.query.reset();
  const changed = createMemo(() => stateText(props.query, props.state) !== stateText(props.query, base()));
  const [names, setNames] = createSignal<ReadonlyMap<string, LookupItem>>(new Map((props.names ?? []).map((item) => [item.value, item])));
  const remember = (items: readonly LookupItem[]) =>
    setNames((before) => {
      const next = new Map(before);
      for (const item of items) next.set(item.value, item);
      return next;
    });

  // A field is active when the state holds a value; a required field always is. A field added from "+ Filter" without
  // a value yet is the draft: a dashed statement that does not apply.
  const active = createMemo(() => fields().filter(([key]) => filters()[key] !== undefined));
  const [draft, setDraft] = createSignal<string>();
  const [open, setOpen] = createSignal<string>();
  const [sheet, setSheet] = createSignal<{ field?: string; display?: "sort" | "group" }>();
  const [saving, setSaving] = createSignal<{ mode: "new" | "rename"; view?: { key: string; label: string; store: ViewStore } }>();

  // The address: one history entry per open editor, one per other change; back and forward lead the state.
  let pushed = false;
  const write = (next: ListQueryState<F, S, G>, entry: boolean) => {
    if (!isServer) {
      const params = props.query.serialize(next, location.search);
      const text = params.toString();
      const url = `${location.pathname}${text ? `?${text}` : ""}${location.hash}`;
      if (entry) history.pushState(history.state, "", url);
      else history.replaceState(history.state, "", url);
    }
    props.onChange(next);
  };
  onMount(() => {
    const back = () => props.onChange(props.query.parse(location.search).state);
    addEventListener("popstate", back);
    onCleanup(() => removeEventListener("popstate", back));
  });
  createEffect(
    on(open, (key) => {
      if (key !== undefined) pushed = false;
    }),
  );
  /** Applies new address text for one field, sort or group; inside an editor the first change makes the entry. */
  // The view the state started from stays in the address: its tab stays current and counts as changed.
  const apply = (edit: (params: URLSearchParams) => void) => {
    const params = props.query.serialize(props.state);
    edit(params);
    const next = props.query.parse(params).state;
    const inEditor = open() !== undefined || sheet() !== undefined;
    write(next, inEditor ? !pushed : true);
    if (inEditor) pushed = true;
  };
  const setField = (key: string, value: unknown) => {
    const definition = props.query.fields[key];
    if (!definition) return;
    const text = encode(definition, value);
    apply((params) => (text === undefined ? params.delete(key) : params.set(key, text)));
    if (text !== undefined && draft() === key) setDraft(undefined);
  };
  const removeField = (key: string) => apply((params) => params.delete(key));
  const reset = () => write(base(), true);

  const values = (key: string, definition: ListQueryField) => valueParts(definition, filters()[key], t(), format(), names());
  const sentence = (key: string, definition: ListQueryField) => statementParts(definition, values(key, definition), t());
  const isDefault = (key: string, definition: ListQueryField) =>
    definition.required !== undefined && encode(definition, filters()[key]) === encode(definition, definition.required);

  // Names for lookup codes of the address the server did not name: resolved once in the browser.
  createEffect(
    on(
      () =>
        active().flatMap(([key, definition]) =>
          definition.kind === "lookup"
            ? codes(filters()[key])
                .filter((code) => !names().has(code))
                .map((code) => [key, code] as const)
            : [],
        ),
      (missing) => {
        const byField = new Map<string, string[]>();
        for (const [key, code] of missing) byField.set(key, [...(byField.get(key) ?? []), code]);
        for (const [key, list] of byField) {
          const definition = props.query.fields[key];
          if (definition?.kind !== "lookup") continue;
          const controller = new AbortController();
          onCleanup(() => controller.abort());
          definition.resolve(list, { signal: controller.signal }).then(
            (found) => !controller.signal.aborted && remember(found),
            () => undefined,
          );
        }
      },
    ),
  );

  const openField = (key: string) => {
    if (isPhone()) {
      setSheet({ field: key });
      return;
    }
    if (filters()[key] === undefined) setDraft(key);
    // the menu hands the focus back to its button first; the editor takes it after
    setTimeout(() => setOpen(key));
  };

  const addEntries = (): MenuEntry[] => {
    const entry = ([key, definition]: [string, ListQueryField]): MenuItem => ({
      label: definition.label,
      icon: props.icons?.[key] ?? undefined,
      meta: filters()[key] === undefined ? undefined : plain(values(key, definition)),
      onClick: () => openField(key),
    });
    const common = fields().filter(([, definition]) => definition.common);
    const rest = fields().filter(([, definition]) => !definition.common);
    if (common.length === 0 || rest.length === 0) return fields().map(entry);
    return [
      { title: t().common, items: common.map(entry) },
      { title: t().further, items: rest.map(entry) },
    ];
  };

  const shown = createMemo(() => {
    const list = active().map(([key]) => key);
    const extra = draft();
    return extra !== undefined && !list.includes(extra) ? [...list, extra] : list;
  });

  const fieldCount = () => active().filter(([key, definition]) => !isDefault(key, definition)).length;

  return (
    <div class="k2-fbar" data-k2-part="FilterBar" role="group" aria-label={t().filters}>
      <Button variant="secondary" icon="adjustments-horizontal" onClick={() => setSheet({})}>
        {t().filterCount}
        <Show when={fieldCount() > 0}>
          <span class="k2-fbar-n">{fieldCount()}</span>
        </Show>
      </Button>
      <div class="k2-fbar-flow">
        <For each={shown()}>
          {(key, index) => {
            const definition = () => props.query.fields[key];
            return (
              <Show when={definition()}>
                {(field) => (
                  <span class="k2-fbar-item">
                    <Show when={index() > 0}>
                      <span class="k2-fbar-and">{t().and}</span>
                    </Show>
                    <Statement
                      fieldKey={key}
                      definition={field()}
                      parts={filters()[key] === undefined ? [] : sentence(key, field())}
                      draft={filters()[key] === undefined}
                      fixed={isDefault(key, field())}
                      open={open() === key}
                      onPhone={() => setSheet({ field: key })}
                      onOpenChange={(next) => {
                        if (next && isPhone()) return;
                        setOpen(next ? key : undefined);
                        if (!next && draft() === key) setDraft(undefined);
                      }}
                      onRemove={() => {
                        removeField(key);
                        if (draft() === key) setDraft(undefined);
                      }}
                    >
                      <Editor
                        fieldKey={key}
                        definition={field()}
                        value={filters()[key]}
                        counts={props.counts?.[key]}
                        names={names()}
                        onNames={remember}
                        onChange={(value) => setField(key, value)}
                        onRemove={
                          field().required === undefined
                            ? () => {
                                setOpen(undefined);
                                removeField(key);
                                setDraft(undefined);
                              }
                            : undefined
                        }
                      />
                    </Statement>
                  </span>
                )}
              </Show>
            );
          }}
        </For>
        <span class="k2-fbar-add">
          <Menu icon="plus" items={addEntries()}>
            {t().addFilter}
          </Menu>
        </span>
        <Show when={changed()}>
          <span class="k2-fbar-reset">
            <Button variant="text" icon="filter-off" onClick={reset}>
              {t().reset}
            </Button>
          </span>
        </Show>
      </div>
      <OrderButtons query={props.query} state={props.state} onOpen={(display) => setSheet({ display })} />
      <Show when={props.views && props.views.stores.length > 0 ? props.views : undefined}>
        {(views) => (
          <div class="k2-fbar-end">
            <ViewMenu
              views={views()}
              changed={changed()}
              onSave={() => setSaving({ mode: "new" })}
              onRename={(view) => setSaving({ mode: "rename", view })}
              onUpdate={async (view) => {
                const saved = await view.store.save({ key: view.key, label: view.label, query: stateText(props.query, props.state) });
                views().onSaved?.(saved, view.store);
              }}
            />
          </div>
        )}
      </Show>
      <Sheet
        open={sheet() !== undefined}
        place={sheet()}
        onPlace={setSheet}
        onClose={() => setSheet(undefined)}
        query={props.query}
        state={props.state}
        icons={props.icons}
        counts={props.counts}
        names={names()}
        onNames={remember}
        changed={changed()}
        results={props.results}
        canSave={(props.views?.stores.some((store) => store.writable) ?? false) && changed()}
        onSave={() => {
          setSheet(undefined);
          setSaving({ mode: "new" });
        }}
        sentence={(key, definition) => plain(values(key, definition))}
        onField={setField}
        onSort={(value) => apply((params) => params.set("sort", value))}
        onGroup={(value) => apply((params) => (value ? params.set("group", value) : params.delete("group")))}
        onReset={reset}
      />
      <Show when={props.views}>
        {(views) => (
          <SaveDialog
            open={saving() !== undefined}
            mode={saving()?.mode ?? "new"}
            view={saving()?.view}
            stores={views().stores}
            summary={[...active().map(([key, definition]) => plain(sentence(key, definition)))]}
            order={orderWords(props.query, props.state, t())}
            query={stateText(props.query, props.state)}
            onClose={() => setSaving(undefined)}
            onSaved={(view, store) => {
              setSaving(undefined);
              views().onSaved?.(view, store);
            }}
          />
        )}
      </Show>
    </div>
  );
};

// ── Statement ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One filter as a sentence: one surface, tinted in the app colour. The words are the button that opens the editor;
 * the small round × removes the filter. A required filter at its default is framed like a field and has no ×; a new
 * filter without a value is white with a dashed edge and does not apply yet. The outer size never changes.
 */
const Statement = (props: {
  fieldKey: string;
  definition: ListQueryField;
  parts: readonly Part[];
  draft: boolean;
  fixed: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** On the phone a statement opens the filter sheet at its field instead of its popover. */
  onPhone: () => void;
  onRemove: () => void;
  children: JSX.Element;
}) => {
  const t = useFilterMessages();
  const popover = usePopover(() => ({ open: props.open, onOpenChange: props.onOpenChange }));
  const words = () => (props.draft ? `${props.definition.label} ${props.definition.op ?? t().is} …` : plain(props.parts));
  const removable = () => !props.draft && (props.definition.required === undefined || !props.fixed);
  return (
    <span
      class="k2-stmt"
      data-k2-part="Statement"
      data-open={props.open ? "" : undefined}
      data-fixed={props.fixed ? "" : undefined}
      data-draft={props.draft ? "" : undefined}
      data-removable={removable() ? "" : undefined}
    >
      <popover.Trigger
        class="k2-stmt-b"
        aria-label={t().edit({ sentence: words() })}
        title={words()}
        // On the phone the sheet opens after the whole tap (its click), so no part of the tap lands on the sheet; the
        // popover's own press handling is skipped there.
        onPointerDown={(event: PointerEvent) => isPhone() && event.preventDefault()}
        onClick={(event: MouseEvent) => {
          if (!isPhone()) return;
          event.preventDefault();
          props.onPhone();
        }}
        onKeyDown={(event: KeyboardEvent) => {
          if (!isPhone() || (event.key !== "Enter" && event.key !== " ")) return;
          event.preventDefault();
          props.onPhone();
        }}
      >
        <Show
          when={!props.draft}
          fallback={
            <>
              {props.definition.label} <span class="k2-stmt-op">{props.definition.op ?? t().is} …</span>
            </>
          }
        >
          <For each={props.parts}>
            {(part) =>
              part.value ? (
                <b>
                  {part.text}
                  <Show when={part.missing}>
                    <Icon name="alert-triangle" label={t().unknownValue} />
                  </Show>
                </b>
              ) : (
                part.text
              )
            }
          </For>
        </Show>
      </popover.Trigger>
      <Show when={removable()}>
        <button
          type="button"
          class="k2-stmt-x"
          aria-label={t().removeFilter({ field: props.definition.label })}
          title={t().removeFilter({ field: props.definition.label })}
          onClick={(event) => {
            // the focus goes on to the next statement, else to "+ Filter"
            const item = event.currentTarget.closest(".k2-fbar-item");
            const next = item?.nextElementSibling;
            props.onRemove();
            queueMicrotask(() => {
              const target =
                (next?.classList.contains("k2-fbar-item") ? next.querySelector<HTMLElement>(".k2-stmt-b") : null) ??
                item?.closest(".k2-fbar-flow")?.querySelector<HTMLElement>(".k2-fbar-add .k2-btn");
              target?.focus();
            });
          }}
        >
          <Icon name="x" />
        </button>
      </Show>
      <popover.Popup class="k2-pop k2-fpop" data-k2-part="Popover" side="bottom" align="start" sideOffset={4} collisionPadding={8}>
        {props.children}
      </popover.Popup>
    </span>
  );
};

// ── Editors ────────────────────────────────────────────────────────────────────────────────────────────────────

type EditorProps = {
  fieldKey: string;
  definition: ListQueryField;
  value: unknown;
  counts?: Readonly<Record<string, number>>;
  names: ReadonlyMap<string, LookupItem>;
  onNames: (items: readonly LookupItem[]) => void;
  onChange: (value: unknown) => void;
  /** Takes the filter out; a required field has none. */
  onRemove?: () => void;
  /** In the phone sheet: no head of its own (the sheet names the field). */
  bare?: boolean;
};

/** The editor of one field, inside the statement's popover or the phone sheet: head, then the values. */
const Editor = (props: EditorProps) => {
  const t = useFilterMessages();
  // The focus goes to the first control of the values, not to "Entfernen" in the head: the search of a lookup, the
  // option that holds the list's tab stop, or the first field. Core moves it into the popup first; this follows.
  const focusValues = (root: HTMLElement) =>
    setTimeout(() => {
      if (!root.isConnected || (!root.contains(document.activeElement) && document.activeElement !== document.body)) return;
      const target = root.querySelector<HTMLElement>(
        '.k2-lookup-search input, [role="option"][tabindex="0"], [role="option"], .k2-fed-field input, .k2-fed-presets .k2-btn',
      );
      target?.focus({ preventScroll: true });
    });
  return (
    <div class="k2-fed" data-k2-part="FilterEditor" ref={focusValues}>
      <Show when={!props.bare}>
        <div class="k2-fed-h">
          <span class="k2-fed-t">{props.definition.label}</span>
          <Show when={saysIs(props.definition)}>
            <span class="k2-fed-op">{props.definition.op ?? t().is}</span>
          </Show>
          <Show when={props.onRemove}>
            {(remove) => (
              <span class="k2-fed-end">
                <Button variant="text" onClick={() => remove()()}>
                  {t().remove}
                </Button>
              </span>
            )}
          </Show>
        </div>
      </Show>
      <EditorBody {...props} />
    </div>
  );
};

const EditorBody = (props: EditorProps) => {
  const definition = props.definition;
  switch (definition.kind) {
    case "choice":
      return (
        <Options
          label={definition.label}
          options={definition.options}
          multiple={definition.multiple}
          value={codes(props.value)}
          counts={definition.counts ? props.counts : undefined}
          onChange={(next) => props.onChange(definition.multiple ? next : next[0])}
        />
      );
    case "lookup":
      return (
        <Lookup
          label={definition.label}
          value={codes(props.value)}
          known={[...props.names.values()]}
          load={async (query, context) => {
            const result = await definition.load(query, context);
            props.onNames(result.items);
            return result;
          }}
          resolve={async (values, context) => {
            const found = await definition.resolve(values, context);
            props.onNames(found);
            return found;
          }}
          limit={definition.limit}
          minChars={definition.minChars}
          onChange={(next) => props.onChange(definition.multiple ? next : next.at(-1))}
        />
      );
    case "numberRange":
      return <RangeEditor definition={definition} value={isRange(props.value) ? props.value : undefined} onChange={props.onChange} />;
    case "dateRange":
    case "timeRange":
      return <PeriodEditor definition={definition} value={isPeriod(props.value) ? props.value : undefined} onChange={props.onChange} />;
    case "bool":
      return (
        <Options
          label={definition.label}
          options={[
            { value: "yes", label: definition.labels.yes },
            { value: "no", label: definition.labels.no },
          ]}
          multiple={false}
          value={typeof props.value === "boolean" ? [props.value ? "yes" : "no"] : []}
          onChange={(next) => props.onChange(next[0] === undefined ? undefined : next[0] === "yes")}
        />
      );
    case "text":
      return <TextEditor label={definition.label} value={typeof props.value === "string" ? props.value : ""} onChange={props.onChange} />;
  }
};

/** Fixed values: the ui-sdk listbox, several (checks) or one (a tick), with counts at the end when the app gives them. */
const Options = (props: {
  label: string;
  options: readonly ListQueryOption[];
  multiple: boolean;
  value: readonly string[];
  counts?: Readonly<Record<string, number>>;
  onChange: (value: string[]) => void;
}) => {
  const t = useFilterMessages();
  const list = useListbox(() => ({
    multiple: props.multiple,
    value: props.multiple ? [...props.value] : (props.value[0] ?? null),
    onValueChange: (next) => props.onChange(Array.isArray(next) ? next : next ? [next] : []),
  }));
  return (
    <>
      <list.Root class="k2-opts" aria-label={props.label}>
        <For each={props.options}>
          {(option) => {
            const on = () => props.value.includes(option.value);
            return (
              <list.Item
                class="k2-opt"
                value={option.value}
                label={option.label}
                data-zero={props.counts?.[option.value] === 0 ? "" : undefined}
              >
                <Show
                  when={props.multiple}
                  fallback={
                    <span class="k2-opt-tick" aria-hidden="true">
                      <Show when={on()}>
                        <Icon name="check" />
                      </Show>
                    </span>
                  }
                >
                  <span class="k2-check" data-checked={on() ? "" : undefined} aria-hidden="true">
                    <Show when={on()}>
                      <Icon name="check" />
                    </Show>
                  </span>
                </Show>
                <span class="k2-opt-label">{option.label}</span>
                <Show when={props.counts?.[option.value] !== undefined}>
                  <span class="k2-opt-count">{props.counts?.[option.value]}</span>
                </Show>
              </list.Item>
            );
          }}
        </For>
      </list.Root>
      <Show when={props.counts}>
        <p class="k2-fed-hint">{t().countsHint}</p>
      </Show>
    </>
  );
};

/** A plain number or text field of the editor, which applies on Enter or when it is left, never per key. */
const EditField = (props: {
  label: string;
  value: string;
  type: "text" | "number" | "date" | "datetime-local";
  unit?: string;
  invalid?: boolean;
  onCommit: (value: string) => void;
}) => (
  <label class="k2-fed-field">
    <span class="k2-fed-label">{props.label}</span>
    <span class="k2-input" data-invalid={props.invalid ? "" : undefined}>
      <input
        type={props.type}
        value={props.value}
        inputmode={props.type === "number" ? "decimal" : undefined}
        aria-invalid={props.invalid ? "true" : undefined}
        onChange={(event) => props.onCommit(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.isComposing) props.onCommit(event.currentTarget.value);
        }}
      />
      <Show when={props.unit}>
        <span class="k2-fed-unit">{props.unit}</span>
      </Show>
    </span>
  </label>
);

const RangeEditor = (props: {
  definition: Extract<ListQueryField, { kind: "numberRange" }>;
  value?: NumberRange;
  onChange: (value: unknown) => void;
}) => {
  const t = useFilterMessages();
  const format = useFormats();
  const [min, setMin] = createSignal(props.value?.min?.toString() ?? "");
  const [max, setMax] = createSignal(props.value?.max?.toString() ?? "");
  const number = (text: string) => (text.trim() === "" ? undefined : Number(text.replace(",", ".")));
  const invalid = () => {
    const low = number(min());
    const high = number(max());
    return low !== undefined && high !== undefined && low > high;
  };
  const commit = () => {
    if (invalid()) return;
    const low = number(min());
    const high = number(max());
    if ((low !== undefined && Number.isNaN(low)) || (high !== undefined && Number.isNaN(high))) return;
    props.onChange(low === undefined && high === undefined ? undefined : { min: low, max: high });
  };
  const unit = () => (props.definition.unit ? ` ${props.definition.unit}` : "");
  const presetLabel = (range: NumberRange) => {
    const show = (amount: number) => `${format().number(amount)}${unit()}`;
    if (range.min !== undefined && range.max !== undefined) return t().between({ min: show(range.min), max: show(range.max) });
    if (range.min !== undefined) return `${t().from} ${show(range.min)}`;
    return range.max !== undefined ? `${t().upTo} ${show(range.max)}` : "";
  };
  return (
    <div class="k2-fed-body">
      <Show when={props.definition.presets.length > 0}>
        <div class="k2-fed-presets">
          <For each={props.definition.presets}>
            {(range) => (
              <Button
                pressed={props.value?.min === range.min && props.value?.max === range.max}
                onClick={() => {
                  setMin(range.min?.toString() ?? "");
                  setMax(range.max?.toString() ?? "");
                  props.onChange(range);
                }}
              >
                {presetLabel(range)}
              </Button>
            )}
          </For>
        </div>
      </Show>
      <div class="k2-fed-range">
        <EditField
          label={t().from_}
          type="number"
          value={min()}
          unit={props.definition.unit}
          invalid={invalid()}
          onCommit={(text) => {
            setMin(text);
            commit();
          }}
        />
        <span class="k2-fed-dash" aria-hidden="true">
          –
        </span>
        <EditField
          label={t().to}
          type="number"
          value={max()}
          unit={props.definition.unit}
          invalid={invalid()}
          onCommit={(text) => {
            setMax(text);
            commit();
          }}
        />
      </div>
      <Show when={invalid()}>
        <p class="k2-fed-error" role="alert">
          {t().rangeInvalid}
        </p>
      </Show>
    </div>
  );
};

const PeriodEditor = (props: {
  definition: Extract<ListQueryField, { kind: "dateRange" | "timeRange" }>;
  value?: PeriodValue;
  onChange: (value: unknown) => void;
}) => {
  const t = useFilterMessages();
  const day = props.definition.kind === "dateRange";
  const custom = () => props.definition.kind === "dateRange" || props.definition.custom;
  // a minute of the address (UTC) shows as the local time a datetime field takes, and back
  const toField = (text: string | undefined) => {
    if (!text) return "";
    if (day) return text;
    const date = new Date(text.replace(/Z$/, ":00Z"));
    if (Number.isNaN(date.getTime())) return "";
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
  };
  const fromField = (text: string) => {
    if (!text) return undefined;
    if (day) return text;
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? undefined : `${date.toISOString().slice(0, 16)}Z`;
  };
  const range = () => (props.value?.kind === "range" ? props.value : undefined);
  const [from, setFrom] = createSignal(toField(range()?.from));
  const [to, setTo] = createSignal(toField(range()?.to));
  const invalid = () => {
    const low = fromField(from());
    const high = fromField(to());
    return low !== undefined && high !== undefined && low > high;
  };
  const commit = () => {
    if (invalid()) return;
    const low = fromField(from());
    const high = fromField(to());
    props.onChange(low === undefined && high === undefined ? undefined : { kind: "range", from: low, to: high });
  };
  return (
    <div class="k2-fed-body" data-flush="">
      <Options
        label={props.definition.label}
        options={props.definition.presets}
        multiple={false}
        value={props.value?.kind === "preset" ? [props.value.preset] : []}
        onChange={(next) => {
          if (next[0]) props.onChange({ kind: "preset", preset: next[0] });
          else if (props.definition.required === undefined) props.onChange(undefined);
        }}
      />
      <Show when={custom()}>
        <div class="k2-fed-sub">{t().customRange}</div>
        <div class="k2-fed-range">
          <EditField
            label={t().from_}
            type={day ? "date" : "datetime-local"}
            value={from()}
            invalid={invalid()}
            onCommit={(text) => {
              setFrom(text);
              commit();
            }}
          />
          <span class="k2-fed-dash" aria-hidden="true">
            –
          </span>
          <EditField
            label={t().to}
            type={day ? "date" : "datetime-local"}
            value={to()}
            invalid={invalid()}
            onCommit={(text) => {
              setTo(text);
              commit();
            }}
          />
        </div>
        <Show when={invalid()}>
          <p class="k2-fed-error" role="alert">
            {t().rangeInvalid}
          </p>
        </Show>
      </Show>
    </div>
  );
};

const TextEditor = (props: { label: string; value: string; onChange: (value: unknown) => void }) => (
  <div class="k2-fed-body">
    <EditField label={props.label} type="text" value={props.value} onCommit={(text) => props.onChange(text.trim() || undefined)} />
  </div>
);

// ── Sort and group ─────────────────────────────────────────────────────────────────────────────────────────────

type OrderWords = { sort?: string; group?: string };

const directionWord = (direction: "asc" | "desc") => (direction === "desc" ? "↓" : "↑");

/** The sort and the grouping in words: "Preis ↓", "Lagerort"; a fixed sort says its own words. */
const orderWords = <F extends Fields, S extends string, G extends string>(
  query: ListQuery<F, S, G>,
  state: ListQueryState<F, S, G>,
  t: FilterMessages,
): OrderWords => {
  const sort = query.sort;
  const groups: Readonly<Record<string, { label: string }>> = query.group ?? {};
  const sortLabel = sort.fixed
    ? sort.fixed.label
    : `${(sort.options as Readonly<Record<string, { label: string }>>)[state.sort.field]?.label ?? state.sort.field} ${directionWord(state.sort.direction)}`;
  return { sort: sortLabel, group: state.group !== undefined ? (groups[state.group]?.label ?? state.group) : undefined };
};

/** The entries of the sort menu: each field in each of its directions. */
const sortEntries = <F extends Fields, S extends string, G extends string>(query: ListQuery<F, S, G>, t: FilterMessages) => {
  if (query.sort.fixed) return [];
  const options: Readonly<Record<string, { label: string; directions?: readonly ("asc" | "desc")[] }>> = query.sort.options;
  return Object.entries(options).flatMap(([key, option]) =>
    (option.directions ?? (["asc", "desc"] as const)).map((direction) => ({
      value: `${key}.${direction}`,
      label: `${option.label} ${directionWord(direction)}`,
    })),
  );
};

const groupEntries = <F extends Fields, S extends string, G extends string>(query: ListQuery<F, S, G>, t: FilterMessages) => {
  const groups: Readonly<Record<string, { label: string }>> = query.group ?? {};
  return [{ value: "", label: t.noGroups }, ...Object.entries(groups).map(([key, group]) => ({ value: key, label: group.label }))];
};

export type ListOrderProps<F extends Fields, S extends string, G extends string> = {
  query: ListQuery<F, S, G>;
  state: ListQueryState<F, S, G>;
  /** Every change, already written to the address, as `FilterBar` does. */
  onChange: (state: ListQueryState<F, S, G>) => void;
};

/**
 * The sort and the grouping of a list in words, for the `filters` place of its `StatusRow`: "⇅ Preis ↓ ▾" and "Nach
 * Lagerort ▾", each a menu with one choice. A fixed sort is text. On the phone they leave with the status row's
 * filters and stand in the filter bar instead.
 */
export const ListOrder = <F extends Fields, S extends string, G extends string>(props: ListOrderProps<F, S, G>) => {
  const t = useFilterMessages();
  const change = (edit: (params: URLSearchParams) => void) => {
    const params = props.query.serialize(props.state);
    edit(params);
    const next = props.query.parse(params).state;
    if (!isServer) {
      const text = props.query.serialize(next, location.search).toString();
      history.pushState(history.state, "", `${location.pathname}${text ? `?${text}` : ""}${location.hash}`);
    }
    props.onChange(next);
  };
  const words = () => orderWords(props.query, props.state, t());
  const groups = () => groupEntries(props.query, t());
  return (
    <span class="k2-order" data-k2-part="ListOrder">
      <Show
        when={!props.query.sort.fixed}
        fallback={
          <span class="k2-order-fixed">
            <Icon name="arrows-sort" />
            {words().sort}
          </span>
        }
      >
        <Menu
          icon="arrows-sort"
          label={t().sort}
          items={[
            {
              title: t().sort,
              choice: `${props.state.sort.field}.${props.state.sort.direction}`,
              onChoose: (value) => change((params) => params.set("sort", value)),
              items: sortEntries(props.query, t()).map((entry) => ({ label: entry.label, value: entry.value })),
            },
          ]}
        >
          {words().sort}
        </Menu>
      </Show>
      <Show when={groups().length > 1}>
        <Menu
          icon="stack-2"
          label={t().group}
          items={[
            {
              title: t().group,
              choice: props.state.group ?? "",
              onChoose: (value) => change((params) => (value ? params.set("group", value) : params.delete("group"))),
              items: groups().map((entry) => ({ label: entry.label, value: entry.value })),
            },
          ]}
        >
          {words().group ? t().groupBy({ field: words().group ?? "" }) : t().noGroups}
        </Menu>
      </Show>
    </span>
  );
};

/** On the phone: the sort and the grouping at the end of the bar's line, each opening the sheet at its place. */
const OrderButtons = <F extends Fields, S extends string, G extends string>(props: {
  query: ListQuery<F, S, G>;
  state: ListQueryState<F, S, G>;
  onOpen: (display: "sort" | "group") => void;
}) => {
  const t = useFilterMessages();
  const words = () => orderWords(props.query, props.state, t());
  return (
    <span class="k2-fbar-order">
      <Show when={!props.query.sort.fixed}>
        <Button icon="arrows-sort" onClick={() => props.onOpen("sort")}>
          {words().sort}
        </Button>
      </Show>
      <Show when={words().group}>
        {(group) => (
          <Button icon="stack-2" onClick={() => props.onOpen("group")}>
            {group()}
          </Button>
        )}
      </Show>
    </span>
  );
};

// ── Views ──────────────────────────────────────────────────────────────────────────────────────────────────────

const scopeIcon = { device: "device-desktop", person: "user", app: "users" } as const;

/** The icon a saved view carries on its tab: a person for "für mich", a device for "auf diesem Gerät". */
export const viewIcon = (scope: ViewStore["scope"] | undefined): string | undefined =>
  scope === "person" ? scopeIcon.person : scope === "device" ? scopeIcon.device : undefined;

const ViewMenu = (props: {
  views: FilterBarViews;
  changed: boolean;
  onSave: () => void;
  onRename: (view: { key: string; label: string; store: ViewStore }) => void;
  onUpdate: (view: { key: string; label: string; store: ViewStore }) => Promise<void>;
}) => {
  const t = useFilterMessages();
  const toast = useToast();
  const current = () => props.views.current;
  const own = () => {
    const view = current();
    const store = view?.scope ? props.views.stores.find((candidate) => candidate.scope === view.scope) : undefined;
    return view && store ? { key: view.key, label: view.label, store } : undefined;
  };
  const writable = () => props.views.stores.some((store) => store.writable);
  const items = (): MenuEntry[] => {
    const view = current();
    const mine = own();
    const deeds: MenuItem[] = [
      {
        label: t().saveAsNew,
        icon: "bookmark-plus",
        disabled: !props.changed || !writable(),
        meta: props.changed ? undefined : t().nothingChanged,
        onClick: props.onSave,
      },
    ];
    if (mine) {
      deeds.push({
        label: t().updateView({ name: mine.label }),
        icon: "device-floppy",
        disabled: !props.changed || !mine.store.writable,
        meta: !mine.store.writable ? t().notAllowed : props.changed ? undefined : t().nothingChanged,
        onClick: () => props.onUpdate(mine),
      });
    }
    deeds.push({
      label: t().copyLink,
      icon: "link",
      onClick: async () => {
        await navigator.clipboard?.writeText(location.href);
        toast(t().linkCopied);
      },
    });
    const entries: MenuEntry[] = [
      view
        ? { title: props.changed ? t().viewChanged({ name: view.label }) : t().viewNamed({ name: view.label }), items: deeds }
        : { title: t().view, items: deeds },
    ];
    if (mine?.store.writable) {
      entries.push(
        { label: t().renameView({ name: mine.label }), icon: "pencil", onClick: () => props.onRename(mine) },
        {
          label: t().deleteView({ name: mine.label }),
          icon: "trash",
          danger: true,
          onClick: async () => {
            await mine.store.remove(mine.key);
            props.views.onRemoved?.(mine.key, mine.store);
            toast(t().deleted({ name: mine.label }));
          },
        },
      );
    }
    return entries;
  };
  return (
    <Menu variant="text" icon="bookmark" label={t().view} items={items()}>
      {t().view}
    </Menu>
  );
};

const scopeWords = (scope: ViewStore["scope"], t: FilterMessages) =>
  scope === "device"
    ? { label: t.scopeDevice, hint: t.scopeDeviceHint }
    : scope === "person"
      ? { label: t.scopePerson, hint: t.scopePersonHint }
      : { label: t.scopeApp, hint: t.scopeAppHint };

const SaveDialog = (props: {
  open: boolean;
  mode: "new" | "rename";
  view?: { key: string; label: string; store: ViewStore };
  stores: readonly ViewStore[];
  summary: readonly string[];
  order: OrderWords;
  query: string;
  onClose: () => void;
  onSaved: (view: SavedListView, store: ViewStore) => void;
}) => {
  const t = useFilterMessages();
  const toast = useToast();
  const writable = () => props.stores.filter((store) => store.writable);
  const [name, setName] = createSignal("");
  const [scope, setScope] = createSignal<ViewStore["scope"]>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        setName(props.mode === "rename" ? (props.view?.label ?? "") : "");
        setScope(props.view?.store.scope ?? writable()[0]?.scope);
        setError(undefined);
        setBusy(false);
      },
    ),
  );
  const store = () =>
    props.mode === "rename" ? props.view?.store : props.stores.find((candidate) => candidate.scope === scope() && candidate.writable);
  const submit = async () => {
    const target = store();
    const label = name().trim();
    if (!target || !label || busy()) return;
    setBusy(true);
    setError(undefined);
    try {
      const saved = await target.save(
        props.mode === "rename" && props.view ? { key: props.view.key, label, query: props.query } : { label, query: props.query },
      );
      toast(t().saved({ name: saved.label }));
      props.onSaved(saved, target);
    } catch (reason) {
      setError(reason instanceof Error && reason.message ? reason.message : t().saveFailed);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={props.mode === "rename" ? t().renameTitle : t().saveTitle}
      open={props.open}
      onOpenChange={(open) => !open && props.onClose()}
      foot={
        <>
          <Button onClick={() => props.onClose()}>{t().cancel}</Button>
          <Button variant="primary" busy={busy()} disabled={!name().trim() || !store()} onClick={() => void submit()}>
            {t().save}
          </Button>
        </>
      }
    >
      <Field label={t().name} error={error()}>
        <Input
          value={name()}
          onInput={setName}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />
      </Field>
      <Show when={props.mode === "new" && props.stores.length > 1}>
        <div class="k2-fsave-scopes" role="radiogroup" aria-label={t().whoSees}>
          <span class="k2-fed-label">{t().whoSees}</span>
          <For each={props.stores}>
            {(candidate) => {
              const words = () => scopeWords(candidate.scope, t());
              return (
                <label class="k2-choice" data-disabled={candidate.writable ? undefined : ""}>
                  <span class="k2-mark">
                    <input
                      class="k2-mark-input"
                      type="radio"
                      name="k2-view-scope"
                      value={candidate.scope}
                      checked={scope() === candidate.scope}
                      disabled={!candidate.writable}
                      onChange={() => setScope(candidate.scope)}
                    />
                    <span class="k2-radio" data-checked={scope() === candidate.scope ? "" : undefined} data-k2-mark="" />
                  </span>
                  <span class="k2-choice-text">
                    {words().label}
                    <span class="k2-fsave-hint">{candidate.writable ? words().hint : `${words().hint} ${t().notAllowed}.`}</span>
                  </span>
                </label>
              );
            }}
          </For>
        </div>
      </Show>
      <Show when={props.mode === "new"}>
        <dl class="k2-fsave-sum">
          <Show when={props.summary.length > 0}>
            <dt>{t().filters}</dt>
            <dd>
              <For each={props.summary}>{(line) => <span>{line}</span>}</For>
            </dd>
          </Show>
          <Show when={props.order.sort}>
            <dt>{t().sort}</dt>
            <dd>{props.order.sort}</dd>
          </Show>
          <Show when={props.order.group}>
            <dt>{t().group}</dt>
            <dd>{props.order.group}</dd>
          </Show>
        </dl>
      </Show>
    </Dialog>
  );
};

// ── Phone sheet ────────────────────────────────────────────────────────────────────────────────────────────────

type SheetPlace = { field?: string; display?: "sort" | "group" };

const Sheet = <F extends Fields, S extends string, G extends string>(props: {
  open: boolean;
  place?: SheetPlace;
  onPlace: (place: SheetPlace) => void;
  onClose: () => void;
  query: ListQuery<F, S, G>;
  state: ListQueryState<F, S, G>;
  icons?: Partial<Record<keyof F & string, string>>;
  counts?: Partial<Record<keyof F & string, Readonly<Record<string, number>>>>;
  names: ReadonlyMap<string, LookupItem>;
  onNames: (items: readonly LookupItem[]) => void;
  changed: boolean;
  results?: string;
  canSave: boolean;
  onSave: () => void;
  sentence: (key: string, definition: ListQueryField) => string;
  onField: (key: string, value: unknown) => void;
  onSort: (value: string) => void;
  onGroup: (value: string) => void;
  onReset: () => void;
}) => {
  const t = useFilterMessages();
  const filters = (): Readonly<Record<string, unknown>> => props.state.filters;
  const field = () => {
    const key = props.place?.field;
    const definition = key === undefined ? undefined : props.query.fields[key];
    return key !== undefined && definition ? { key, definition } : undefined;
  };
  const words = () => orderWords(props.query, props.state, t());
  const title = () =>
    field()?.definition.label ?? (props.place?.display === "sort" ? t().sort : props.place?.display === "group" ? t().group : t().filters);
  const Row = (row: { icon?: string; label: string; value?: string; onClick: () => void }) => (
    <button type="button" class="k2-fsheet-row" onClick={row.onClick}>
      <Show when={row.icon}>{(name) => <Icon name={name()} />}</Show>
      <span class="k2-fsheet-label">{row.label}</span>
      <span class="k2-fsheet-value" data-set={row.value ? "" : undefined}>
        {row.value ?? t().all}
      </span>
      <Icon name="chevron-right" />
    </button>
  );
  const Single = (single: { label: string; options: readonly ListQueryOption[]; value: string; onChange: (value: string) => void }) => (
    <Options
      label={single.label}
      options={single.options}
      multiple={false}
      value={[single.value]}
      onChange={(next) => next[0] !== undefined && single.onChange(next[0])}
    />
  );
  return (
    <Dialog
      title={title()}
      open={props.open}
      onOpenChange={(open) => !open && props.onClose()}
      foot={
        <>
          <Button disabled={!props.changed} onClick={props.onReset}>
            {t().reset}
          </Button>
          <Button variant="primary" onClick={props.onClose}>
            {props.results ? t().show({ results: props.results }) : t().done}
          </Button>
        </>
      }
    >
      <div class="k2-fsheet" data-k2-part="FilterSheet">
        <Show
          when={props.place?.field !== undefined || props.place?.display !== undefined}
          fallback={
            <>
              <div class="k2-fsheet-sec">{t().filters}</div>
              <For each={Object.entries(props.query.fields)}>
                {([key, definition]) => (
                  <Row
                    icon={props.icons?.[key]}
                    label={definition.label}
                    value={filters()[key] === undefined ? undefined : props.sentence(key, definition)}
                    onClick={() => props.onPlace({ field: key })}
                  />
                )}
              </For>
              <Show when={!props.query.sort.fixed || props.query.group}>
                <div class="k2-fsheet-sec">{t().display}</div>
                <Show when={!props.query.sort.fixed}>
                  <Row icon="arrows-sort" label={t().sort} value={words().sort} onClick={() => props.onPlace({ display: "sort" })} />
                </Show>
                <Show when={props.query.group}>
                  <Row
                    icon="stack-2"
                    label={t().group}
                    value={words().group ?? t().noGroups}
                    onClick={() => props.onPlace({ display: "group" })}
                  />
                </Show>
              </Show>
              <Show when={props.canSave}>
                <div class="k2-fsheet-sec">{t().view}</div>
                <button type="button" class="k2-fsheet-row" onClick={props.onSave}>
                  <Icon name="bookmark-plus" />
                  <span class="k2-fsheet-label">{t().saveAsNew}</span>
                </button>
              </Show>
            </>
          }
        >
          <div class="k2-fsheet-back">
            <Button variant="ghost" icon="chevron-left" label={t().back} onClick={() => props.onPlace({})} />
          </div>
          <Show when={field()}>
            {(current) => (
              <Editor
                bare
                fieldKey={current().key}
                definition={current().definition}
                value={filters()[current().key]}
                counts={props.counts?.[current().key]}
                names={props.names}
                onNames={props.onNames}
                onChange={(value) => props.onField(current().key, value)}
              />
            )}
          </Show>
          <Show when={props.place?.display === "sort"}>
            <Single
              label={t().sort}
              options={sortEntries(props.query, t())}
              value={`${props.state.sort.field}.${props.state.sort.direction}`}
              onChange={props.onSort}
            />
          </Show>
          <Show when={props.place?.display === "group"}>
            <Single label={t().group} options={groupEntries(props.query, t())} value={props.state.group ?? ""} onChange={props.onGroup} />
          </Show>
        </Show>
      </div>
    </Dialog>
  );
};
