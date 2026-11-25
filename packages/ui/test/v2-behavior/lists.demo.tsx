import { createSignal, For } from "solid-js";
import { useListbox } from "../../src/v2/behavior/lists";

const mails = [
  { value: "m1", label: "Angebot Eichenplatten" },
  { value: "m2", label: "Unterlagen drittes Quartal" },
  { value: "m3", label: "Termin Abholung", disabled: true },
  { value: "m4", label: "Lieferung Freitag" },
  { value: "m5", label: "Fotos vom Tisch" },
];

/** A mail list: a listbox with several rows selected. */
export function Demo() {
  const [selected, setSelected] = createSignal<string[]>(["m1"]);
  const list = useListbox(() => ({
    multiple: true,
    value: selected(),
    onValueChange: (value) => setSelected(Array.isArray(value) ? value : value ? [value] : []),
  }));
  return (
    <div class="page">
      <div>
        <list.Root aria-label="Nachrichten" class="listbox" data-testid="listbox">
          <For each={mails}>
            {(mail) => (
              <list.Item class="option" value={mail.value} label={mail.label} disabled={mail.disabled}>
                {mail.label}
                <list.ItemIndicator item={mail.value}>✓</list.ItemIndicator>
              </list.Item>
            )}
          </For>
        </list.Root>
        <output data-testid="selected">{selected().join(",")}</output>
      </div>
    </div>
  );
}
