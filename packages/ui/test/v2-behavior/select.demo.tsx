import { createSignal, For } from "solid-js";
import { type ChoiceItem, useCombobox, useSelect } from "../../src/v2/behavior/select";

const states: ChoiceItem[] = [
  { value: "open", label: "Offen" },
  { value: "doing", label: "In Arbeit" },
  { value: "done", label: "Erledigt" },
  { value: "rejected", label: "Abgelehnt", disabled: true },
  { value: "waiting", label: "Wartet" },
];
const people: ChoiceItem[] = [
  { value: "anna", label: "Anna Berg" },
  { value: "bernd", label: "Bernd Kraus" },
  { value: "carla", label: "Carla Dietz" },
  { value: "dora", label: "Dora Ernst" },
  { value: "emil", label: "Emil Fuchs" },
];
const labelOf = (items: ChoiceItem[], value: string) => items.find((item) => item.value === value)?.label ?? value;

/** A select (controlled, one value), a select with several values, and a combobox with chips. */
export function Demo() {
  const [state, setState] = createSignal<string | null>("doing");
  const [tags, setTags] = createSignal<string[]>([]);
  const [assignees, setAssignees] = createSignal<string[]>(["anna"]);
  const select = useSelect(() => ({ items: states, value: state(), onValueChange: setState, placeholder: "Status wählen" }));
  const multi = useSelect(() => ({ items: states, multiple: true, value: tags(), onValueChange: setTags, placeholder: "Keine" }));
  const combobox = useCombobox(() => ({ items: people, multiple: true, value: assignees(), onValueChange: setAssignees }));
  const option = (parts: Pick<typeof select, "Item" | "ItemIndicator">) => (item: ChoiceItem) => (
    <parts.Item class="option" value={item.value} label={item.label} disabled={item.disabled}>
      {item.label}
      <parts.ItemIndicator item={item.value}>✓</parts.ItemIndicator>
    </parts.Item>
  );
  return (
    <div class="form">
      <div class="field">
        <select.Label>Status</select.Label>
        <select.Trigger class="btn" data-testid="select-trigger">
          <select.Value placeholder="Status wählen" />
        </select.Trigger>
        <select.Popup class="listbox" sideOffset={4} collisionPadding={8} option={option(select)} />
        <output data-testid="select-value">{state() ?? "–"}</output>
      </div>
      <div class="field">
        <multi.Label>Markierungen</multi.Label>
        <multi.Trigger class="btn" data-testid="multi-trigger">
          <multi.Value placeholder="Keine" />
        </multi.Trigger>
        <multi.Popup class="listbox" sideOffset={4} collisionPadding={8} option={option(multi)} />
        <output data-testid="multi-value">{tags().join(",")}</output>
      </div>
      <div class="field">
        <combobox.Label>Zuständig</combobox.Label>
        <combobox.Chips class="chips">
          <For each={assignees()}>
            {(value) => (
              <combobox.Chip class="chip" value={value} data-chip={value}>
                {labelOf(people, value)}
                <combobox.ChipRemove value={value} aria-label={`${labelOf(people, value)} entfernen`}>
                  ×
                </combobox.ChipRemove>
              </combobox.Chip>
            )}
          </For>
          <combobox.Input class="input" data-testid="combobox-input" />
        </combobox.Chips>
        <combobox.Popup class="listbox" sideOffset={4} collisionPadding={8} option={option(combobox)}>
          <combobox.Empty>Keine Treffer</combobox.Empty>
        </combobox.Popup>
        <output data-testid="combobox-value">{assignees().join(",")}</output>
      </div>
    </div>
  );
}
