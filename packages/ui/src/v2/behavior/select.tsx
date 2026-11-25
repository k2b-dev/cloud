/**
 * Select and Combobox behaviour for v2: listbox keys, typeahead, highlight, selection, positioning, search and chips
 * come from core. They lean on core's list internals (`api.internal`, `instance.use(feature)`), so they are the first
 * place an update of `@ui-sdk/core` can need adapter work; the contract tests cover both.
 */
import { combobox as comboboxPrimitive } from "@ui-sdk/core/combobox";
import { comboboxChips } from "@ui-sdk/core/renderer";
import { select as selectPrimitive } from "@ui-sdk/core/select";
import { For, type JSX, mergeProps, onMount, Show, splitProps } from "solid-js";
import {
  type Handle,
  keyed,
  type PartProps,
  type Props,
  part,
  popupComponent,
  type SlotComponent,
  slotComponent,
  usePrimitive,
} from "./adapter";
import { type BehaviorMessages, useBehaviorMessages } from "./messages";

/** What core announces about a list: results after a search, or a value taken out (a chip). */
type ListChange = { type: "results"; count: number; loading: boolean } | { type: "removed"; label: string };

/** Core's own list announcements are English only ("3 results"); these come from the render locale. */
const listAnnouncement =
  (t: () => BehaviorMessages) =>
  (change: ListChange): string =>
    change.type === "removed"
      ? t().listRemoved({ label: change.label })
      : change.loading
        ? t().loading
        : change.count
          ? t().listResults({ count: change.count })
          : t().listEmpty;

/** One choice. `value` is the stable key, `label` what the trigger, typeahead and search read. */
export type ChoiceItem = { value: string; label: string; disabled?: boolean };

type ChoiceOptions<Value> = {
  items: ChoiceItem[];
  value?: Value;
  defaultValue?: Value;
  onValueChange?: (value: Value) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  /** The name the value is sent under in a form, through `FormInput`. */
  name?: string;
  /** The text of the search field (`Input` in the list); closing the list empties it. */
  query?: string;
  onQueryChange?: (query: string) => void;
  /** How the search narrows the list: `false` keeps every item, for items a server already found for the text. */
  filter?: false | "contains" | "startsWith";
  /** Whether the items are loading or failed, for `Status` and `Empty`; the list is `aria-busy` while loading. */
  status?: "idle" | "loading" | "error";
  /** The highlight or scrolling reached the last item: the next page can load. */
  onLoadMore?: () => void;
  /** The words of a value whose item is not in the list now, such as a chosen value of a search. */
  itemToLabel?: (value: string) => string;
  /** `"auto"`: a sheet from the bottom on small touch screens, else under the trigger. */
  presentation?: "popover" | "sheet" | "auto";
};

export type SelectOptions = ChoiceOptions<string | null>;
export type MultiSelectOptions = ChoiceOptions<string[]> & { multiple: true };

export type SelectParts = {
  Label: SlotComponent;
  Trigger: SlotComponent;
  /** The chosen label, or the placeholder. */
  Value: SlotComponent;
  /**
   * The list, shown while open. `option` renders each item core lists, which a search narrows; other children follow
   * the options. Takes `side`, `align`, `sideOffset`, `collisionPadding`, `alignItemWithTrigger`.
   */
  Popup: (props: PartProps & { option: (item: ChoiceItem) => JSX.Element; head?: JSX.Element }) => JSX.Element;
  /** One option: `value`, `label`, `disabled`. */
  Item: SlotComponent;
  /** The mark of a selected option; pass the option's value as `item`. */
  ItemIndicator: SlotComponent;
  /** Its children show only while no option matches. */
  Empty: (props: EmptyProps) => JSX.Element;
  Clear: SlotComponent;
  /**
   * Core's form input: a visually hidden input under `name` that a form sends and validates (`required` blocks an empty
   * submit), that a form's reset puts back to the first value, that autofill fills, and that fires `change`.
   */
  FormInput: SlotComponent;
  /** A search field inside the list: what is typed goes to `onQueryChange`, the keys still move the highlight. */
  Input: SlotComponent;
  /** What the list says about its items: its children function gets `{ status }` (loading, failed). */
  Status: SlotComponent;
};

/** The given items in the order core lists them (a search leaves some out); core's list holds the same data. */
const listed = (list: unknown, items: ChoiceItem[]): ChoiceItem[] => {
  if (!Array.isArray(list)) return [];
  const byValue = new Map(items.map((item) => [item.value, item]));
  return list.flatMap((entry: unknown) => {
    const value = typeof entry === "object" && entry !== null && "value" in entry ? entry.value : entry;
    const item = typeof value === "string" ? byValue.get(value) : undefined;
    return item ? [item] : [];
  });
};

const listPopup =
  (Popup: SlotComponent, items: () => ChoiceItem[]): SelectParts["Popup"] =>
  (props) => {
    const [own, rest] = splitProps(props, ["option", "children", "head"]);
    return Popup(
      mergeProps(rest, {
        children: (state: Props) => (
          <>
            {own.head}
            <For each={listed(state.items, items())}>{(item) => own.option(item)}</For>
            {own.children}
          </>
        ),
      }),
    );
  };

type EmptyProps = { [key: string]: unknown; children?: JSX.Element };

const emptyComponent =
  (Empty: SlotComponent): ((props: EmptyProps) => JSX.Element) =>
  (props) => {
    const [own, rest] = splitProps(props, ["children"]);
    return Empty(mergeProps(rest, { children: (state: Props) => <Show when={state.empty}>{own.children}</Show> }));
  };

/**
 * A value is shown before the list has ever opened. With `items` as data core finds every label itself; without them
 * it needs the items registered once (`prepare`), as `@ui-sdk/solid` does.
 */
const prepareLabels = (handle: Handle<typeof selectPrimitive> | Handle<typeof comboboxPrimitive>) =>
  onMount(() => {
    const { internal } = handle.api;
    if (internal.selection.needsItems(internal.hasValueIcon())) internal.prepare();
  });

/** The value part shows the chosen labels, or its `placeholder` while nothing is chosen, unless given children. */
const valueComponent =
  (Value: SlotComponent): SlotComponent =>
  (props) =>
    Value(
      mergeProps(props, {
        get children() {
          return (
            props.children ??
            ((state: Props): JSX.Element => {
              const text = state.placeholder ? props.placeholder : state.label;
              return typeof text === "string" ? text : "";
            })
          );
        },
      }),
    );

/** A select: one value, or several with `multiple`. */
export function useSelect(options: () => SelectOptions | MultiSelectOptions): SelectParts {
  const announcement = listAnnouncement(useBehaviorMessages());
  const handle = usePrimitive(selectPrimitive, () => ({ ...options(), announcement }));
  prepareLabels(handle);
  return {
    Label: slotComponent(handle, "label", "div"),
    Trigger: slotComponent(handle, "trigger", "button"),
    Value: valueComponent(slotComponent(handle, "value", "span")),
    Popup: listPopup(popupComponent(handle, "content"), () => options().items),
    Item: slotComponent(handle, "item", "div"),
    ItemIndicator: slotComponent(handle, "item-indicator", "span"),
    Empty: emptyComponent(slotComponent(handle, "empty", "div")),
    Clear: slotComponent(handle, "clear", "button"),
    FormInput: slotComponent(handle, "form-input", "input"),
    Input: slotComponent(handle, "input", "input"),
    Status: slotComponent(handle, "status", "div"),
  };
}

export type ComboboxParts = Omit<SelectParts, "Status"> & {
  /** The search field that also holds focus while the list is open. */
  Input: SlotComponent;
  /** The chips of a multiple combobox, with `Chip` and `ChipRemove` per value (pass `value`). */
  Chips: SlotComponent;
  Chip: SlotComponent;
  ChipRemove: SlotComponent;
};

/** A combobox: a search field that filters its list. Several values show as chips. */
export function useCombobox(
  options: () => (SelectOptions | MultiSelectOptions) & { onQueryChange?: (query: string) => void },
): ComboboxParts {
  const announcement = listAnnouncement(useBehaviorMessages());
  const handle = usePrimitive(comboboxPrimitive, () => ({ ...options(), announcement }));
  prepareLabels(handle);
  // Chips are a feature core adds to an instance on demand, as `@ui-sdk/solid` does when it renders them.
  handle.instance.use(comboboxChips);
  return {
    Label: slotComponent(handle, "label", "label"),
    Input: slotComponent(handle, "input", "input"),
    Trigger: slotComponent(handle, "trigger", "button"),
    Value: valueComponent(slotComponent(handle, "value", "span")),
    Popup: listPopup(popupComponent(handle, "content"), () => options().items),
    Item: slotComponent(handle, "item", "div"),
    ItemIndicator: slotComponent(handle, "item-indicator", "span"),
    Empty: emptyComponent(slotComponent(handle, "empty", "div")),
    Clear: slotComponent(handle, "clear", "button"),
    FormInput: slotComponent(handle, "form-input", "input"),
    Chips: slotComponent(handle, "chips", "div"),
    Chip: chipComponent(handle, "chip", "div"),
    ChipRemove: chipComponent(handle, "chip-remove", "button"),
  };
}

/** Feature slots are not in the primitive's schema, so a chip's `value` is split off here. */
const chipComponent =
  (handle: Handle<typeof comboboxPrimitive>, slot: "chip" | "chip-remove", tag: string): SlotComponent =>
  (props) => {
    const [own, element] = splitProps(props, ["value"]);
    return part(handle, slot, () => keyed(handle, String(own.value)), element, tag);
  };
