import { createEffect, createMemo, createSignal, createUniqueId, For, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { isServer } from "solid-js/web";
import { useLocale } from "../intl/locale";
import { useListbox } from "./behavior/lists";
import { usePopover } from "./behavior/overlays";
import { Button } from "./button";
import { Choice, Field, Input } from "./controls";
import { DatePicker } from "./date-picker";
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
  SortDirection,
  SortOption,
  ViewStore,
} from "./list-query";
import { Lookup } from "./lookup";
import { Icon } from "./marks";
import { Menu, type MenuEntry, type MenuItem } from "./menu";
import { readNumber, showNumber } from "./number-text";
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
const periodValue = (value: unknown): PeriodValue | undefined => (isPeriod(value) ? value : undefined);
const periodOf = (definition: ListQueryField): Extract<ListQueryField, { kind: "dateRange" | "timeRange" }> | undefined =>
  definition.kind === "dateRange" || definition.kind === "timeRange" ? definition : undefined;
const rangeValue = (value: unknown): NumberRange | undefined => (isRange(value) ? value : undefined);
const rangeOf = (definition: ListQueryField): Extract<ListQueryField, { kind: "numberRange" }> | undefined =>
  definition.kind === "numberRange" ? definition : undefined;
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

/**
 * The wall time of a moment in a time zone, as a datetime field holds it ("2026-11-24T09:00"), and back: the zone is
 * explicit, so the server and every browser read the same minute the same way.
 */
const wallTime = (moment: number, timeZone: string): string => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(new Date(moment))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};
/**
 * The moment of a wall time in a zone, or `undefined` when the wall time does not exist there (the clocks jump over
 * it in spring). A wall time that exists twice (the clocks go back in autumn) means its first occurrence; an editor
 * keeps the instant of a bound that was not changed, so this rule only applies to a time that was typed.
 */
const fromWallTime = (wall: string, timeZone: string): number | undefined => {
  const guess = Date.parse(`${wall}:00Z`);
  if (Number.isNaN(guess)) return undefined;
  const offset = (moment: number) => Date.parse(`${wallTime(moment, timeZone)}:00Z`) - moment;
  const halfDay = 12 * 60 * 60 * 1000;
  // the zone's offsets half a day before and after: around a change of the clocks they differ
  const candidates = [guess - offset(guess - halfDay), guess - offset(guess + halfDay)]
    .filter((moment) => wallTime(moment, timeZone) === wall)
    .sort((a, b) => a - b);
  return candidates[0];
};

const useFormats = (timeZone: () => string): (() => Formats) => {
  const locale = useLocale();
  return createMemo(() => {
    const number = new Intl.NumberFormat(locale());
    const day = new Intl.DateTimeFormat(locale(), { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
    const minute = new Intl.DateTimeFormat(locale(), {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: timeZone(),
    });
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

/**
 * The state after one change of the address, or `undefined` when the address cannot hold it. `parse` reports every
 * part it had to drop, a value it does not accept or a query over the 2,000 characters a link carries (then it falls
 * back to the default state); any report refuses the change, so a list never silently loses its filters. The change
 * goes through the address text because the editors hold values of any field; `set` gives the same guarantee for
 * code that knows its field's type.
 */
const follow = <F extends Fields, S extends string, G extends string>(
  query: ListQuery<F, S, G>,
  state: ListQueryState<F, S, G>,
  edit: (params: URLSearchParams) => void,
): ListQueryState<F, S, G> | undefined => {
  const params = query.serialize(state);
  edit(params);
  const { state: next, issues } = query.parse(params);
  return issues.length > 0 ? undefined : next;
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
  /**
   * The view the state started from, when it is a saved one or one in code (`scope` undefined): its name, the query
   * it holds (renaming keeps it; updating replaces it with the state shown) and its store.
   */
  current?: { key: string; label: string; query: string; scope?: ViewStore["scope"] };
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
  /**
   * Names of lookup values per field, which the server resolved (`resolve`) for the codes of the address, so the first
   * picture shows names. Per field, because two lookups may use the same code for different things.
   */
  names?: Partial<Record<keyof F & string, readonly LookupItem[]>>;
  /**
   * The time zone points in time (`timeRange`) are read and entered in, such as the person's own ("Europe/Berlin");
   * "UTC" by default. Give the same zone on the server and in the browser, so the first picture and the island agree.
   */
  timeZone?: string;
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
  const timeZone = () => props.timeZone ?? "UTC";
  const format = useFormats(timeZone);
  const fields = createMemo(() => Object.entries(props.query.fields));
  const filters = (): Readonly<Record<string, unknown>> => props.state.filters;
  const base = () => props.base ?? props.query.reset();
  const changed = createMemo(() => stateText(props.query, props.state) !== stateText(props.query, base()));
  // Names of lookup codes, per field and code: two lookups may use the same code for different things. A list that
  // brings nothing new leaves the map as it is, so nothing that reads it runs again.
  const nameKey = (field: string, code: string) => `${field}\u0000${code}`;
  const given: Readonly<Record<string, readonly LookupItem[] | undefined>> = props.names ?? {};
  const [names, setNames] = createSignal<ReadonlyMap<string, LookupItem>>(
    new Map(Object.entries(given).flatMap(([field, items]) => (items ?? []).map((item) => [nameKey(field, item.value), item] as const))),
  );
  const remember = (field: string, items: readonly LookupItem[]) =>
    setNames((before) => {
      const fresh = items.filter((item) => {
        const known = before.get(nameKey(field, item.value));
        return !known || known.label !== item.label || known.meta !== item.meta;
      });
      if (fresh.length === 0) return before;
      const next = new Map(before);
      for (const item of fresh) next.set(nameKey(field, item.value), item);
      return next;
    });
  /** The names of one field, by code. */
  const namesOf = (field: string): ReadonlyMap<string, LookupItem> =>
    new Map([...names()].flatMap(([key, item]) => (key.startsWith(`${field}\u0000`) ? [[item.value, item] as const] : [])));

  // A field is active when the state holds a value; a required field always is. A field added from "+ Filter" without
  // a value yet is the draft: a dashed statement that does not apply.
  const active = createMemo(() => fields().filter(([key]) => filters()[key] !== undefined));
  const [draft, setDraft] = createSignal<string>();
  const [open, setOpen] = createSignal<string>();
  const [sheet, setSheet] = createSignal<SheetPlace>();
  // The sheet opens in the task after the press that asks for it: WebKit can deliver the end of a tap after its click,
  // and the sheet, open by then, would take it for a press outside and close again.
  const openSheet = (place: SheetPlace) => setTimeout(() => setSheet(place));
  const [saving, setSaving] = createSignal<{
    mode: "new" | "rename";
    view?: { key: string; label: string; query: string; store: ViewStore };
  }>();

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
  // an editor session (a popover or the phone's sheet) starts a new history entry with its first change
  createEffect(
    on(
      () => open() !== undefined || sheet() !== undefined,
      (editing) => {
        if (editing) pushed = false;
      },
    ),
  );
  /** Applies new address text for one field, sort or group; inside an editor the first change makes the entry. */
  // The view the state started from stays in the address: its tab stays current and counts as changed.
  // What the address cannot hold (a value parse would drop, a number it cannot write, more than 2000 characters) is
  // never written: the editor that asked says so at its field, and the list stays as it is.
  const apply = (edit: (params: URLSearchParams) => void): boolean => {
    const next = follow(props.query, props.state, edit);
    if (!next) return false;
    const inEditor = open() !== undefined || sheet() !== undefined;
    write(next, inEditor ? !pushed : true);
    if (inEditor) pushed = true;
    return true;
  };
  const setField = (key: string, value: unknown): boolean => {
    const definition = props.query.fields[key];
    if (!definition) return false;
    const text = encode(definition, value);
    const applied = apply((params) => (text === undefined ? params.delete(key) : params.set(key, text)));
    if (applied && text !== undefined && draft() === key) setDraft(undefined);
    // emptying every bound in the open editor keeps that editor: the filter waits as a dashed draft that does not apply
    if (applied && text === undefined && open() === key && definition.required === undefined) setDraft(key);
    return applied;
  };
  const removeField = (key: string) => apply((params) => params.delete(key));
  /** Whether the address could hold this value of a field: what cannot is offered locked. */
  const canSet = (key: string, value: unknown) => {
    const definition = props.query.fields[key];
    if (!definition) return false;
    const text = encode(definition, value);
    return follow(props.query, props.state, (params) => (text === undefined ? params.delete(key) : params.set(key, text))) !== undefined;
  };
  const canEdit = (edit: (params: URLSearchParams) => void) => follow(props.query, props.state, edit) !== undefined;
  const reset = () => write(base(), true);

  const values = (key: string, definition: ListQueryField) => valueParts(definition, filters()[key], t(), format(), namesOf(key));
  const sentence = (key: string, definition: ListQueryField) => statementParts(definition, values(key, definition), t());
  const isDefault = (key: string, definition: ListQueryField) =>
    definition.required !== undefined && encode(definition, filters()[key]) === encode(definition, definition.required);

  // Names for lookup codes of the address the server did not name: each code is asked for once in the browser. A code
  // the app cannot name (deleted, or the load failed) stays a code with a warning; opening its editor asks again.
  const asked = new Set<string>();
  const resolving = new Set<AbortController>();
  onCleanup(() => {
    for (const controller of resolving) controller.abort();
  });
  createEffect(() => {
    const byField = new Map<string, string[]>();
    for (const [key, definition] of active()) {
      if (definition.kind !== "lookup") continue;
      for (const code of codes(filters()[key])) {
        if (names().has(nameKey(key, code)) || asked.has(nameKey(key, code))) continue;
        asked.add(nameKey(key, code));
        byField.set(key, [...(byField.get(key) ?? []), code]);
      }
    }
    for (const [key, list] of byField) {
      const definition = props.query.fields[key];
      if (definition?.kind !== "lookup") continue;
      const controller = new AbortController();
      resolving.add(controller);
      definition.resolve(list, { signal: controller.signal }).then(
        (found) => {
          resolving.delete(controller);
          if (!controller.signal.aborted) remember(key, found);
        },
        () => resolving.delete(controller),
      );
    }
  });

  const openField = (key: string) => {
    if (isPhone()) {
      openSheet({ field: key });
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
      <Button variant="secondary" icon="adjustments-horizontal" onClick={() => openSheet({})}>
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
                      onPhone={() => openSheet({ field: key })}
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
                        names={namesOf(key)}
                        onNames={(items) => remember(key, items)}
                        timeZone={timeZone()}
                        possible={(value) => canSet(key, value)}
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
      <OrderButtons query={props.query} state={props.state} onOpen={(display) => openSheet({ display })} />
      <Show when={props.views && props.views.stores.length > 0 ? props.views : undefined}>
        {(views) => (
          <div class="k2-fbar-end">
            <ViewMenu
              views={views()}
              changed={changed()}
              onSave={() => setSaving({ mode: "new" })}
              onRename={(view) => setSaving({ mode: "rename", view })}
              query={stateText(props.query, props.state)}
              onUpdate={async (view, query) => {
                const saved = await view.store.save({ key: view.key, label: view.label, query });
                views().onSaved?.(saved, view.store);
                return saved;
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
        namesOf={namesOf}
        onNames={remember}
        timeZone={timeZone()}
        canSet={canSet}
        canEdit={canEdit}
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
  let popup: HTMLElement | undefined;
  // a draft says what it will be, in the grammar of its kind: "Lagerort ist …", but "Preis …" (a range brings its own words)
  const draftWord = () => props.definition.op ?? (saysIs(props.definition) ? t().is : undefined);
  const words = () =>
    props.draft ? [props.definition.label, draftWord(), "…"].filter((word) => word !== undefined).join(" ") : plain(props.parts);
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
              {props.definition.label} <span class="k2-stmt-op">{draftWord() === undefined ? "…" : `${draftWord()} …`}</span>
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
      <popover.Popup
        ref={(element: HTMLElement) => {
          popup = element;
        }}
        // the focus goes once, as the popover opens, to the first control of the values; nothing moves it later, so a
        // field the person is typing in keeps it
        initialFocus={() => firstValue(popup)}
        class="k2-pop k2-fpop"
        data-k2-part="Popover"
        side="bottom"
        align="start"
        sideOffset={4}
        collisionPadding={8}
      >
        {props.children}
      </popover.Popup>
    </span>
  );
};

/**
 * The first control of an editor's values, where its focus goes when it opens: the search of a lookup, the option that
 * holds a list's tab stop, else the first field, option or bound ("Ab …"); never "Entfernen" in the head.
 */
const firstValue = (root: HTMLElement | undefined): HTMLElement | null =>
  root?.querySelector<HTMLElement>(".k2-lookup-search input") ??
  root?.querySelector<HTMLElement>('[role="option"][tabindex="0"]') ??
  root?.querySelector<HTMLElement>('.k2-fed-field input, [role="option"], .k2-fed-bounds > .k2-mi') ??
  null;

// ── Editors ────────────────────────────────────────────────────────────────────────────────────────────────────

type EditorProps = {
  fieldKey: string;
  definition: ListQueryField;
  value: unknown;
  counts?: Readonly<Record<string, number>>;
  names: ReadonlyMap<string, LookupItem>;
  onNames: (items: readonly LookupItem[]) => void;
  /** The zone points in time are entered in. */
  timeZone: string;
  /** Whether the address could hold this value: what could not is offered locked. */
  possible: (value: unknown) => boolean;
  /** Applies a value; `false` when the address cannot hold it (the editor then shows why, and nothing changes). */
  onChange: (value: unknown) => boolean;
  /** Takes the filter out; a required field has none. */
  onRemove?: () => void;
  /** In the phone sheet: no head of its own (the sheet names the field). */
  bare?: boolean;
  /**
   * In the phone sheet: "Von …" and "Bis …" of a period open their calendar, "Ab …" and "Bis …" of a number range
   * their number entry, as the sheet's next step.
   */
  onBound?: (bound: Bound) => void;
};

/** The editor of one field, inside the statement's popover or the phone sheet: head, then the values. */
const Editor = (props: EditorProps) => {
  const t = useFilterMessages();
  const [refused, setRefused] = createSignal(false);
  return (
    <div class="k2-fed" data-k2-part="FilterEditor">
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
      <EditorBody
        {...props}
        onChange={(value) => {
          const applied = props.onChange(value);
          setRefused(!applied);
          return applied;
        }}
      />
      {/* ranges, periods and text say it at their own fields */}
      <Show
        when={refused() && (props.definition.kind === "choice" || props.definition.kind === "lookup" || props.definition.kind === "bool")}
      >
        <p class="k2-fed-error" data-flush="" role="alert">
          {t().valueRejected}
        </p>
      </Show>
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
          possible={(code) => {
            const chosen = codes(props.value);
            if (!definition.multiple) return props.possible(code);
            return props.possible(chosen.includes(code) ? chosen.filter((other) => other !== code) : [...chosen, code]);
          }}
          onChange={(next) => props.onChange(definition.multiple ? next : next[0])}
        />
      );
    case "lookup":
      return (
        <Lookup
          label={definition.label}
          value={codes(props.value)}
          known={[...props.names.values()]}
          // names are kept only from an answer that still counts: a search a newer one aborted renames nothing
          load={async (query, context) => {
            const result = await definition.load(query, context);
            if (!context.signal.aborted) props.onNames(result.items);
            return result;
          }}
          resolve={async (values, context) => {
            const found = await definition.resolve(values, context);
            if (!context.signal.aborted) props.onNames(found);
            return found;
          }}
          limit={definition.limit}
          minChars={definition.minChars}
          failure={definition.failure}
          multiple={definition.multiple}
          onChange={(next) => props.onChange(definition.multiple ? next : next.at(-1))}
        />
      );
    case "numberRange":
      return (
        <RangeEditor
          definition={definition}
          value={isRange(props.value) ? props.value : undefined}
          possible={props.possible}
          onChange={props.onChange}
          onBound={props.onBound}
        />
      );
    case "dateRange":
    case "timeRange":
      return (
        <PeriodEditor
          definition={definition}
          value={isPeriod(props.value) ? props.value : undefined}
          timeZone={props.timeZone}
          possible={props.possible}
          onChange={props.onChange}
          onBound={props.onBound}
        />
      );
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
          possible={(code) => props.possible(code === "yes")}
          onChange={(next) => props.onChange(next[0] === undefined ? undefined : next[0] === "yes")}
        />
      );
    case "text":
      return <TextEditor label={definition.label} value={typeof props.value === "string" ? props.value : ""} onChange={props.onChange} />;
  }
};

/**
 * Fixed values: the ui-sdk listbox, several (a box first) or one (a tick at the row's end), with counts before the end
 * when the app gives them.
 */
const Options = (props: {
  label: string;
  options: readonly ListQueryOption[];
  multiple: boolean;
  value: readonly string[];
  counts?: Readonly<Record<string, number>>;
  /** Whether choosing (or, with several, ticking) this value is possible; an impossible one is locked. */
  possible?: (value: string) => boolean;
  onChange: (value: string[]) => void;
}) => {
  const t = useFilterMessages();
  const hint = createUniqueId();
  const locked = (value: string) => props.possible !== undefined && !props.value.includes(value) && !props.possible(value);
  const anyLocked = () => props.options.some((option) => locked(option.value));
  const list = useListbox(() => ({
    multiple: props.multiple,
    value: props.multiple ? [...props.value] : (props.value[0] ?? null),
    // "" is a value of its own ("Keine Gruppen"), not "nothing chosen"
    onValueChange: (next) => props.onChange(Array.isArray(next) ? next : next === null || next === undefined ? [] : [next]),
  }));
  return (
    <>
      <list.Root class="k2-opts" aria-label={props.label} aria-describedby={anyLocked() ? hint : undefined}>
        <For each={props.options}>
          {(option) => {
            const on = () => props.value.includes(option.value);
            return (
              <list.Item
                class="k2-opt"
                value={option.value}
                label={option.label}
                disabled={locked(option.value)}
                aria-describedby={locked(option.value) ? hint : undefined}
                data-zero={props.counts?.[option.value] === 0 ? "" : undefined}
              >
                {/* several: the box first; one: the tick at the end of the row, where Menu and Select put it */}
                <Show when={props.multiple}>
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
                <Show when={!props.multiple}>
                  <span class="k2-opt-tick" aria-hidden="true">
                    <Show when={on()}>
                      <Icon name="check" />
                    </Show>
                  </span>
                </Show>
              </list.Item>
            );
          }}
        </For>
      </list.Root>
      {/* why some values are locked, and what frees them; the locked options point here */}
      <Show when={anyLocked()}>
        <p class="k2-fed-hint" id={hint}>
          {t().addressFull}
        </p>
      </Show>
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
  type: "text" | "number";
  unit?: string;
  invalid?: boolean;
  /** `unreadable`: the browser could not read what was typed (such as "1e" in a number field), which it shows as "". */
  onCommit: (value: string, unreadable: boolean) => void;
}) => (
  <label class="k2-fed-field">
    <span class="k2-fed-label">{props.label}</span>
    <span class="k2-input">
      <input
        type={props.type}
        value={props.value}
        inputmode={props.type === "number" ? "decimal" : undefined}
        aria-invalid={props.invalid ? "true" : undefined}
        onChange={(event) => props.onCommit(event.currentTarget.value, event.currentTarget.validity.badInput)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.isComposing) props.onCommit(event.currentTarget.value, event.currentTarget.validity.badInput);
        }}
      />
      <Show when={props.unit}>
        <span class="k2-fed-unit">{props.unit}</span>
      </Show>
    </span>
  </label>
);

type RangeField = Extract<ListQueryField, { kind: "numberRange" }>;

/** The address text of a range, which names a preset as an option of the list ("500..2000"). */
const rangeCode = (range: NumberRange) => `${range.min ?? ""}..${range.max ?? ""}`;

/** A range in words with the app's unit: "bis 500 €", "500 € bis 2.000 €", "ab 2.000 €". */
const useRangeWords = (unit: () => string | undefined) => {
  const t = useFilterMessages();
  const format = useFormats(() => "UTC");
  const amount = (value: number) => `${format().number(value)}${unit() ? ` ${unit()}` : ""}`;
  const range = (value: NumberRange) => {
    if (value.min !== undefined && value.max !== undefined) return t().between({ min: amount(value.min), max: amount(value.max) });
    if (value.min !== undefined) return `${t().from} ${amount(value.min)}`;
    return value.max !== undefined ? `${t().upTo} ${amount(value.max)}` : "";
  };
  return { amount, range };
};

/**
 * One bound of a number range: a text field that reads and shows numbers in the locale of `@k2b/ui` ("1.500" is one
 * thousand five hundred in German), with the unit at its end and no spinner. Enter or "Anwenden" applies; an empty
 * field takes the bound out. What does not apply says why under the field, which stays open.
 */
const NumberEntry = (props: {
  label: string;
  value?: number;
  unit?: string;
  /** Applies the bound; an error text when it does not apply. */
  onApply: (value: number | undefined) => string | undefined;
  /** The phone sheet: the keyboard waits for a tap, as everywhere in the sheet. */
  sheet?: boolean;
}) => {
  const t = useFilterMessages();
  const locale = useLocale();
  const shown = (value: number | undefined) => (value === undefined ? "" : showNumber(value, locale()));
  const [text, setText] = createSignal(shown(props.value));
  const [error, setError] = createSignal<string>();
  const apply = () => {
    const read = readNumber(text(), locale());
    if ("refused" in read) return setError(read.refused === "inexact" ? t().tooManyDigits : t().notANumber);
    const refused = props.onApply(read.value ?? undefined);
    setError(refused);
    if (!refused) setText(shown(read.value ?? undefined));
  };
  return (
    <div class="k2-nentry" data-k2-part="NumberEntry">
      <label class="k2-fed-field">
        <span class="k2-fed-label">{props.label}</span>
        <span class="k2-input" data-invalid={error() ? "" : undefined}>
          <input
            // the field takes the focus as its popover opens, unless the person already went on to another field
            ref={(input) =>
              !props.sheet &&
              setTimeout(() => {
                const now = document.activeElement;
                if (input.isConnected && !(now instanceof HTMLInputElement || now instanceof HTMLTextAreaElement))
                  input.focus({ preventScroll: true });
              })
            }
            type="text"
            inputmode="decimal"
            autocomplete="off"
            spellcheck={false}
            value={text()}
            aria-invalid={error() ? "true" : undefined}
            onInput={(event) => {
              setText(event.currentTarget.value);
              setError(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.isComposing) return;
              event.preventDefault();
              apply();
            }}
          />
          <Show when={props.unit}>
            <span class="k2-fed-unit">{props.unit}</span>
          </Show>
        </span>
      </label>
      <Show when={error()}>
        {(message) => (
          <p class="k2-fed-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <div class="k2-dpick-foot">
        <span class="k2-dpick-end">
          <Button variant="primary" onClick={apply}>
            {t().apply}
          </Button>
        </span>
      </div>
    </div>
  );
};

/** The range after one bound was set (`undefined` takes it out), or why it cannot be. */
const rangeWith = (
  value: NumberRange | undefined,
  bound: Bound,
  amount: number | undefined,
): { value?: NumberRange } | { error: "invalid" } => {
  const next = { min: bound === "from" ? amount : value?.min, max: bound === "to" ? amount : value?.max };
  if (next.min !== undefined && next.max !== undefined && next.min > next.max) return { error: "invalid" };
  return { value: next.min === undefined && next.max === undefined ? undefined : next };
};

/** The number entry of one bound, applied through the address; `onDone` once it applied. */
const RangeBound = (props: {
  definition: RangeField;
  value?: NumberRange;
  bound: Bound;
  onChange: (value: unknown) => boolean;
  onDone: () => void;
  sheet?: boolean;
}) => {
  const t = useFilterMessages();
  return (
    <NumberEntry
      label={`${props.definition.label} ${props.bound === "from" ? t().from : t().upTo}`}
      value={props.bound === "from" ? props.value?.min : props.value?.max}
      unit={props.definition.unit}
      sheet={props.sheet}
      onApply={(amount) => {
        const next = rangeWith(props.value, props.bound, amount);
        if ("error" in next) return t().amountInvalid;
        if (!props.onChange(next.value)) return t().valueRejected;
        props.onDone();
        return undefined;
      }}
    />
  );
};

/**
 * A number range, in the pattern of a period: the presets as a list with one tick, then "Ab …" and "Bis …" with their
 * value, each opening a small number entry beside the editor like a submenu (on the phone the sheet's next step).
 */
const RangeEditor = (props: {
  definition: RangeField;
  value?: NumberRange;
  possible: (value: unknown) => boolean;
  onChange: (value: unknown) => boolean;
  onBound?: (bound: Bound) => void;
}) => {
  const t = useFilterMessages();
  const words = useRangeWords(() => props.definition.unit);
  const [rejected, setRejected] = createSignal(false);
  createEffect(
    on(
      () => (props.value ? rangeCode(props.value) : ""),
      () => setRejected(false),
      { defer: true },
    ),
  );
  const presets = () => props.definition.presets.map((range) => ({ value: rangeCode(range), label: words.range(range), range }));
  const shown = (bound: Bound) => {
    const amount = bound === "from" ? props.value?.min : props.value?.max;
    return amount === undefined ? undefined : words.amount(amount);
  };
  return (
    <div class="k2-fed-body" data-flush="">
      <Show when={presets().length > 0}>
        <Options
          label={props.definition.label}
          options={presets()}
          multiple={false}
          value={props.value ? [rangeCode(props.value)] : []}
          possible={(code) => {
            const preset = presets().find((entry) => entry.value === code);
            return preset !== undefined && props.possible(preset.range);
          }}
          onChange={(next) => {
            const preset = presets().find((entry) => entry.value === next[0]);
            if (preset) setRejected(!props.onChange(preset.range));
          }}
        />
        <div class="k2-fed-sub">{t().customAmount}</div>
      </Show>
      <div class="k2-fed-bounds" role="group" aria-label={t().customAmount}>
        <For each={["from", "to"] as const}>
          {(bound) => (
            <BoundEntry
              label={bound === "from" ? t().atLeast : t().atMost}
              shown={shown(bound)}
              onStep={props.onBound && (() => props.onBound?.(bound))}
            >
              {(close) => (
                <RangeBound definition={props.definition} value={props.value} bound={bound} onChange={props.onChange} onDone={close} />
              )}
            </BoundEntry>
          )}
        </For>
      </div>
      <Show when={rejected()}>
        <p class="k2-fed-error" role="alert">
          {t().valueRejected}
        </p>
      </Show>
    </div>
  );
};

type Bound = "from" | "to";
type PeriodField = Extract<ListQueryField, { kind: "dateRange" | "timeRange" }>;
/** Why a bound did not apply: a wall time the clocks jump over, "Von" after "Bis", or a value the address refuses. */
type BoundError = "missing" | "invalid" | "rejected";

/**
 * The bounds of a period as the picker shows them, and the period one picked bound makes. A day stays a day; a minute
 * of the address (UTC) shows as the wall time of the app's zone and goes back from it. A bound that was not changed
 * keeps its instant, also when its wall time exists twice; a wall time that does not exist is refused.
 */
const periodBounds = (definition: PeriodField, value: PeriodValue | undefined, timeZone: string) => {
  const day = definition.kind === "dateRange";
  const range = value?.kind === "range" ? value : undefined;
  const toWall = (text: string | undefined) => {
    if (!text) return undefined;
    if (day) return text;
    const moment = Date.parse(text.replace(/Z$/, ":00Z"));
    return Number.isNaN(moment) ? undefined : wallTime(moment, timeZone);
  };
  const fromWall = (text: string, original: string | undefined): { value?: string; missing?: true } => {
    if (day) return { value: text };
    if (original !== undefined && text === toWall(original)) return { value: original };
    const moment = fromWallTime(text, timeZone);
    return moment === undefined ? { missing: true } : { value: `${new Date(moment).toISOString().slice(0, 16)}Z` };
  };
  return {
    day,
    wall: (bound: Bound) => toWall(range?.[bound]),
    /** The period after one bound was picked (`undefined` takes it out), or why it cannot be. */
    with: (bound: Bound, text: string | undefined): { value: PeriodValue | undefined } | { error: BoundError } => {
      const other: Bound = bound === "from" ? "to" : "from";
      const picked = text === undefined ? {} : fromWall(text, range?.[bound]);
      if (picked.missing) return { error: "missing" };
      const ends = { [bound]: picked.value, [other]: range?.[other] } as { from?: string; to?: string };
      if (ends.from !== undefined && ends.to !== undefined && ends.from > ends.to) return { error: "invalid" };
      return { value: ends.from === undefined && ends.to === undefined ? undefined : { kind: "range", from: ends.from, to: ends.to } };
    },
  };
};

const boundError = (error: BoundError, t: FilterMessages) =>
  error === "missing" ? t.timeMissing : error === "invalid" ? t.rangeInvalid : t.valueRejected;

/**
 * The calendar of one bound: a day (with a time for points in time) applies through the address like every other
 * change. What does not apply says why under the calendar, which stays open; what applies calls `onDone`.
 */
const BoundPicker = (props: {
  definition: PeriodField;
  value?: PeriodValue;
  bound: Bound;
  timeZone: string;
  onChange: (value: unknown) => boolean;
  onDone: () => void;
  /** The phone sheet: the focus waits for a tap, as everywhere in the sheet. */
  sheet?: boolean;
}) => {
  const t = useFilterMessages();
  const [error, setError] = createSignal<BoundError>();
  const bounds = () => periodBounds(props.definition, props.value, props.timeZone);
  const apply = (text: string | undefined) => {
    const next = bounds().with(props.bound, text);
    if ("error" in next) return setError(next.error);
    if (!props.onChange(next.value)) return setError("rejected");
    setError(undefined);
    props.onDone();
  };
  return (
    <DatePicker
      value={bounds().wall(props.bound)}
      time={!bounds().day}
      defaultTime={props.bound === "to" ? "23:59" : "00:00"}
      timeZone={bounds().day ? undefined : props.timeZone}
      label={`${props.definition.label} ${props.bound === "from" ? t().from_ : t().to}`}
      error={error() && boundError(error()!, t())}
      autoFocus={!props.sheet}
      onPick={apply}
      onClear={() => apply(undefined)}
    />
  );
};

/** "Von …" or "Bis …" with its value: a menu entry that opens its calendar beside the editor, like a submenu. */
const BoundEntry = (props: {
  label: string;
  shown?: string;
  /** On the phone the calendar is the sheet's next step instead. */
  onStep?: () => void;
  children: (close: () => void) => JSX.Element;
}) => {
  const [open, setOpen] = createSignal(false);
  const popover = usePopover(() => ({ open: open(), onOpenChange: setOpen }));
  const face = (
    <>
      <span class="k2-mi-label">{props.label}</span>
      <span class="k2-mi-meta" data-set={props.shown ? "" : undefined}>
        {props.shown ?? "…"}
      </span>
      <Icon name="chevron-right" />
    </>
  );
  return (
    <Show
      when={!props.onStep}
      fallback={
        <button type="button" class="k2-mi" onClick={() => props.onStep?.()}>
          {face}
        </button>
      }
    >
      <popover.Trigger
        class="k2-mi"
        data-open={open() ? "" : undefined}
        onKeyDown={(event: KeyboardEvent) => {
          // the key of a submenu: to the side opens it
          if (event.key !== "ArrowRight") return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        {face}
      </popover.Trigger>
      <popover.Popup class="k2-pop k2-dpop" data-k2-part="Popover" side="right" align="start" sideOffset={4} collisionPadding={8}>
        {props.children(() => setOpen(false))}
      </popover.Popup>
    </Show>
  );
};

const PeriodEditor = (props: {
  definition: PeriodField;
  value?: PeriodValue;
  timeZone: string;
  possible: (value: unknown) => boolean;
  onChange: (value: unknown) => boolean;
  onBound?: (bound: Bound) => void;
}) => {
  const t = useFilterMessages();
  const format = useFormats(() => props.timeZone);
  const custom = () => props.definition.kind === "dateRange" || props.definition.custom;
  const range = () => (props.value?.kind === "range" ? props.value : undefined);
  const [rejected, setRejected] = createSignal(false);
  createEffect(
    on(
      () => `${props.value?.kind}:${encode(props.definition, props.value) ?? ""}`,
      () => setRejected(false),
      { defer: true },
    ),
  );
  const shown = (bound: Bound) => {
    const text = range()?.[bound];
    if (!text) return undefined;
    return props.definition.kind === "dateRange" ? format().day(text) : format().minute(text);
  };
  return (
    <div class="k2-fed-body" data-flush="">
      <Options
        label={props.definition.label}
        options={props.definition.presets}
        multiple={false}
        value={props.value?.kind === "preset" ? [props.value.preset] : []}
        possible={(preset) => props.possible({ kind: "preset", preset })}
        onChange={(next) => {
          if (next[0]) setRejected(!props.onChange({ kind: "preset", preset: next[0] }));
          else if (props.definition.required === undefined) setRejected(!props.onChange(undefined));
        }}
      />
      <Show when={custom()}>
        <div class="k2-fed-sub">{t().customRange}</div>
        <div class="k2-fed-bounds" role="group" aria-label={t().customRange}>
          <For each={["from", "to"] as const}>
            {(bound) => (
              <BoundEntry
                label={bound === "from" ? t().from_ : t().to}
                shown={shown(bound)}
                onStep={props.onBound && (() => props.onBound?.(bound))}
              >
                {(close) => (
                  <BoundPicker
                    definition={props.definition}
                    value={props.value}
                    bound={bound}
                    timeZone={props.timeZone}
                    onChange={props.onChange}
                    onDone={close}
                  />
                )}
              </BoundEntry>
            )}
          </For>
        </div>
      </Show>
      {/* a preset the address cannot hold says so here; a bound says it at its calendar */}
      <Show when={rejected()}>
        <p class="k2-fed-error" role="alert">
          {t().valueRejected}
        </p>
      </Show>
    </div>
  );
};

const TextEditor = (props: { label: string; value: string; onChange: (value: unknown) => boolean }) => {
  const t = useFilterMessages();
  const [rejected, setRejected] = createSignal(false);
  return (
    <div class="k2-fed-body">
      <EditField
        label={props.label}
        type="text"
        value={props.value}
        invalid={rejected()}
        onCommit={(text, unreadable) => setRejected(unreadable || !props.onChange(text.trim() || undefined))}
      />
      <Show when={rejected()}>
        <p class="k2-fed-error" role="alert">
          {t().valueRejected}
        </p>
      </Show>
    </div>
  );
};

// ── Sort and group ─────────────────────────────────────────────────────────────────────────────────────────────

type OrderWords = { sort?: string; group?: string };

const bothDirections: readonly SortDirection[] = ["asc", "desc"];

/** A direction in words, by what the sort orders: "Neueste zuerst", "Höchster zuerst", "A–Z"; the app's words first. */
const directionWords = (option: SortOption | undefined, direction: SortDirection, t: FilterMessages): string => {
  const own = option?.labels?.[direction];
  if (own) return own;
  const descending = direction === "desc";
  switch (option?.kind) {
    case "date":
      return descending ? t.newestFirst : t.oldestFirst;
    case "number":
      return descending ? t.highestFirst : t.lowestFirst;
    case "text":
      return descending ? t.zToA : t.aToZ;
    default:
      return descending ? t.descending : t.ascending;
  }
};

const sortOptions = <F extends Fields, S extends string, G extends string>(
  query: ListQuery<F, S, G>,
): Readonly<Record<string, SortOption>> => (query.sort.fixed ? {} : query.sort.options);

/** The sort and the grouping in words: "Preis · Höchster zuerst", "Lagerort"; a fixed sort says its own words. */
const orderWords = <F extends Fields, S extends string, G extends string>(
  query: ListQuery<F, S, G>,
  state: ListQueryState<F, S, G>,
  t: FilterMessages,
): OrderWords => {
  const sort = query.sort;
  const groups: Readonly<Record<string, { label: string }>> = query.group ?? {};
  const option = sortOptions(query)[state.sort.field];
  const sortLabel = sort.fixed
    ? sort.fixed.label
    : t.orderWords({ field: option?.label ?? state.sort.field, order: directionWords(option, state.sort.direction, t) });
  return { sort: sortLabel, group: state.group !== undefined ? (groups[state.group]?.label ?? state.group) : undefined };
};

/** The address text of the sort a choice gives. */
const sortOf = (entries: readonly { value: string; sort: string }[], value: string) =>
  entries.find((entry) => entry.value === value)?.sort ?? "";

/**
 * The two choices of a sort: what it sorts by (the fields) and its order in words (the directions of the field shown).
 * Picking another field keeps the order shown when that field offers it, else takes the field's first direction.
 */
const sortChoices = <F extends Fields, S extends string, G extends string>(
  query: ListQuery<F, S, G>,
  state: ListQueryState<F, S, G>,
  t: FilterMessages,
) => {
  const options = sortOptions(query);
  const directionsOf = (key: string) => options[key]?.directions ?? bothDirections;
  const fields = Object.entries(options).map(([key, option]) => {
    const offered = directionsOf(key);
    const direction = offered.includes(state.sort.direction) ? state.sort.direction : (offered[0] ?? state.sort.direction);
    return { value: key, label: option.label, sort: `${key}.${direction}` };
  });
  const current = options[state.sort.field];
  const orders = directionsOf(state.sort.field).map((direction) => ({
    value: direction,
    label: directionWords(current, direction, t),
    sort: `${state.sort.field}.${direction}`,
  }));
  return { fields, orders, field: state.sort.field, direction: state.sort.direction };
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
 * The sort and the grouping of a list in words, for the `filters` place of its `StatusRow`: "⇅ Preis · Höchster
 * zuerst ▾" and "Nach Lagerort ▾". The sort's menu has two choices, "Sortieren nach" (the fields) and "Reihenfolge"
 * (the order in words, by the field's `kind` or its own `labels`); the grouping's menu has one. A fixed sort is text.
 * On the phone they leave with the status row's filters and stand in the filter bar instead.
 */
export const ListOrder = <F extends Fields, S extends string, G extends string>(props: ListOrderProps<F, S, G>) => {
  const t = useFilterMessages();
  // a choice whose state the address cannot hold is locked in the menu, so a choice never drops the filters
  const change = (edit: (params: URLSearchParams) => void) => {
    const next = follow(props.query, props.state, edit);
    if (!next) return;
    if (!isServer) {
      const text = props.query.serialize(next, location.search).toString();
      history.pushState(history.state, "", `${location.pathname}${text ? `?${text}` : ""}${location.hash}`);
    }
    props.onChange(next);
  };
  const words = () => orderWords(props.query, props.state, t());
  const groups = () => groupEntries(props.query, t());
  const choices = () => sortChoices(props.query, props.state, t());
  const fits = (sort: string) => follow(props.query, props.state, (params) => params.set("sort", sort)) !== undefined;
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
              title: t().sortBy,
              choice: choices().field,
              onChoose: (value) => {
                const sort = choices().fields.find((entry) => entry.value === value)?.sort;
                if (sort) change((params) => params.set("sort", sort));
              },
              items: choices().fields.map((entry) => ({ label: entry.label, value: entry.value, disabled: !fits(entry.sort) })),
            },
            {
              title: t().order,
              choice: choices().direction,
              onChoose: (value) => change((params) => params.set("sort", `${choices().field}.${value}`)),
              items: choices().orders.map((entry) => ({ label: entry.label, value: entry.value, disabled: !fits(entry.sort) })),
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
              items: groups().map((entry) => ({
                label: entry.label,
                value: entry.value,
                disabled: !follow(props.query, props.state, (params) =>
                  entry.value ? params.set("group", entry.value) : params.delete("group"),
                ),
              })),
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
  onRename: (view: { key: string; label: string; query: string; store: ViewStore }) => void;
  /** The state shown, as the query an update writes. */
  query: string;
  /** Writes `query` into the view; a retry writes the same view and query again. */
  onUpdate: (view: { key: string; label: string; query: string; store: ViewStore }, query: string) => Promise<SavedListView>;
}) => {
  const t = useFilterMessages();
  const toast = useToast();
  const current = () => props.views.current;
  const own = () => {
    const view = current();
    const store = view?.scope ? props.views.stores.find((candidate) => candidate.scope === view.scope) : undefined;
    return view && store ? { key: view.key, label: view.label, query: view.query, store } : undefined;
  };
  const writable = () => props.views.stores.some((store) => store.writable);
  /** Runs a deed on a store; when it fails, a short toast names what failed and offers to run the same deed again. */
  const attempt = async (deed: () => Promise<unknown>, kind: "update" | "delete"): Promise<void> => {
    try {
      await deed();
    } catch {
      const retry = () => attempt(deed, kind);
      if (kind === "update") toast(t().updateFailed, { status: "bad", retry });
      else toast(t().deleteFailed, { status: "bad", retry });
    }
  };
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
        onClick: () => {
          // the write is fixed when it is asked for: a retry writes this view and this query, whatever the list shows then
          const query = props.query;
          return attempt(() => props.onUpdate(mine, query), "update");
        },
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
          onClick: () =>
            attempt(async () => {
              await mine.store.remove(mine.key);
              props.views.onRemoved?.(mine.key, mine.store);
              toast(t().deleted({ name: mine.label }));
            }, "delete"),
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
  view?: { key: string; label: string; query: string; store: ViewStore };
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
        // renaming changes the name only: the view keeps the query it holds, whatever the list shows now
        props.mode === "rename" && props.view ? { key: props.view.key, label, query: props.view.query } : { label, query: props.query },
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
      <Field label={t().name} hint={t().nameHint} error={error()}>
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
        <Field label={t().whoSees}>
          <Choice
            name="k2-view-scope"
            value={scope()}
            onChange={(value) => setScope(props.stores.find((candidate) => candidate.scope === value)?.scope)}
            options={props.stores.map((candidate) => {
              const words = scopeWords(candidate.scope, t());
              return {
                value: candidate.scope,
                label: words.label,
                hint: candidate.writable ? words.hint : `${words.hint} ${t().notAllowed}.`,
                disabled: !candidate.writable,
              };
            })}
          />
        </Field>
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

/** Where the sheet stands: the list of fields, one field, the calendar of one bound of a period, the sort or the group. */
type SheetPlace = { field?: string; bound?: Bound; display?: "sort" | "group" };

const Sheet = <F extends Fields, S extends string, G extends string>(props: {
  open: boolean;
  place?: SheetPlace;
  onPlace: (place: SheetPlace) => void;
  onClose: () => void;
  query: ListQuery<F, S, G>;
  state: ListQueryState<F, S, G>;
  icons?: Partial<Record<keyof F & string, string>>;
  counts?: Partial<Record<keyof F & string, Readonly<Record<string, number>>>>;
  namesOf: (field: string) => ReadonlyMap<string, LookupItem>;
  onNames: (field: string, items: readonly LookupItem[]) => void;
  timeZone: string;
  canSet: (key: string, value: unknown) => boolean;
  canEdit: (edit: (params: URLSearchParams) => void) => boolean;
  changed: boolean;
  results?: string;
  canSave: boolean;
  onSave: () => void;
  sentence: (key: string, definition: ListQueryField) => string;
  onField: (key: string, value: unknown) => boolean;
  onSort: (value: string) => boolean;
  onGroup: (value: string) => boolean;
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
  const choices = () => sortChoices(props.query, props.state, t());
  const title = () => {
    const current = field();
    const bound = props.place?.bound;
    if (current && bound) {
      const words = current.definition.kind === "numberRange" ? [t().atLeast, t().atMost] : [t().from_, t().to];
      return `${current.definition.label} · ${bound === "from" ? words[0] : words[1]}`;
    }
    return (
      current?.definition.label ?? (props.place?.display === "sort" ? t().sort : props.place?.display === "group" ? t().group : t().filters)
    );
  };
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
  const Single = (single: {
    label: string;
    options: readonly ListQueryOption[];
    value: string;
    possible: (value: string) => boolean;
    onChange: (value: string) => boolean;
  }) => {
    const [refused, setRefused] = createSignal(false);
    return (
      <>
        <Options
          label={single.label}
          options={single.options}
          multiple={false}
          value={[single.value]}
          possible={single.possible}
          onChange={(next) => next[0] !== undefined && setRefused(!single.onChange(next[0]))}
        />
        <Show when={refused()}>
          <p class="k2-fed-error" data-flush="" role="alert">
            {t().valueRejected}
          </p>
        </Show>
      </>
    );
  };
  return (
    <Dialog
      title={title()}
      open={props.open}
      onOpenChange={(open) => !open && props.onClose()}
      // from a bound's calendar back to its period, from a field back to the list
      back={
        props.place?.field !== undefined || props.place?.display !== undefined
          ? () => props.onPlace(props.place?.bound ? { field: props.place.field } : {})
          : undefined
      }
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
          <Show when={field()}>
            {(current) => (
              <Show
                when={(() => {
                  const definition = current().definition;
                  const bound = props.place?.bound;
                  return bound && (periodOf(definition) || definition.kind === "numberRange") ? { definition, bound } : undefined;
                })()}
                fallback={
                  <Editor
                    bare
                    fieldKey={current().key}
                    definition={current().definition}
                    value={filters()[current().key]}
                    counts={props.counts?.[current().key]}
                    names={props.namesOf(current().key)}
                    onNames={(items) => props.onNames(current().key, items)}
                    timeZone={props.timeZone}
                    possible={(value) => props.canSet(current().key, value)}
                    onChange={(value) => props.onField(current().key, value)}
                    onBound={(bound) => props.onPlace({ field: current().key, bound })}
                  />
                }
              >
                {(step) => (
                  <div class="k2-fsheet-pick">
                    <Show
                      when={periodOf(step().definition)}
                      fallback={
                        <Show when={rangeOf(step().definition)}>
                          {(range) => (
                            <RangeBound
                              sheet
                              definition={range()}
                              value={rangeValue(filters()[current().key])}
                              bound={step().bound}
                              onChange={(value) => props.onField(current().key, value)}
                              onDone={() => props.onPlace({ field: current().key })}
                            />
                          )}
                        </Show>
                      }
                    >
                      {(period) => (
                        <BoundPicker
                          sheet
                          definition={period()}
                          value={periodValue(filters()[current().key])}
                          bound={step().bound}
                          timeZone={props.timeZone}
                          onChange={(value) => props.onField(current().key, value)}
                          onDone={() => props.onPlace({ field: current().key })}
                        />
                      )}
                    </Show>
                  </div>
                )}
              </Show>
            )}
          </Show>
          <Show when={props.place?.display === "sort"}>
            <div class="k2-fsheet-sec">{t().sortBy}</div>
            <Single
              label={t().sortBy}
              options={choices().fields}
              value={choices().field}
              possible={(value) => props.canEdit((params) => params.set("sort", sortOf(choices().fields, value)))}
              onChange={(value) => props.onSort(sortOf(choices().fields, value))}
            />
            <div class="k2-fsheet-sec">{t().order}</div>
            <Single
              label={t().order}
              options={choices().orders}
              value={choices().direction}
              possible={(value) => props.canEdit((params) => params.set("sort", sortOf(choices().orders, value)))}
              onChange={(value) => props.onSort(sortOf(choices().orders, value))}
            />
          </Show>
          <Show when={props.place?.display === "group"}>
            <Single
              label={t().group}
              options={groupEntries(props.query, t())}
              value={props.state.group ?? ""}
              possible={(value) => props.canEdit((params) => (value ? params.set("group", value) : params.delete("group")))}
              onChange={props.onGroup}
            />
          </Show>
        </Show>
      </div>
    </Dialog>
  );
};
