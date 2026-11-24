import { createSignal, For, type JSX, Show } from "solid-js";
import { useListbox, useTree } from "../../src/v2/behavior/lists";

const mails = [
  { value: "m1", label: "Angebot Eichenplatten" },
  { value: "m2", label: "Unterlagen drittes Quartal" },
  { value: "m3", label: "Termin Abholung", disabled: true },
  { value: "m4", label: "Lieferung Freitag" },
  { value: "m5", label: "Fotos vom Tisch" },
];

type Folder = { value: string; label: string; children?: Folder[] };
const folders: Folder[] = [
  { value: "inbox", label: "Posteingang" },
  {
    value: "projects",
    label: "Projekte",
    children: [
      { value: "oak", label: "Eichentisch" },
      { value: "suppliers", label: "Lieferanten" },
    ],
  },
  {
    value: "more",
    label: "Mehr",
    children: [
      { value: "archive", label: "Archiv" },
      { value: "drafts", label: "Entwürfe" },
      {
        value: "hidden",
        label: "Ausgeblendet (2)",
        children: [
          { value: "spam", label: "Spam" },
          { value: "old", label: "Alt" },
        ],
      },
    ],
  },
];

/** A mail list (listbox, several rows) and a folder navigation (tree, current page, actions). */
export function Demo() {
  const [selected, setSelected] = createSignal<string[]>(["m1"]);
  const [opened, setOpened] = createSignal("–");
  const list = useListbox(() => ({
    multiple: true,
    value: selected(),
    onValueChange: (value) => setSelected(Array.isArray(value) ? value : value ? [value] : []),
  }));
  const nav = useTree(() => ({ mode: "none", current: "inbox", onAction: setOpened }));
  const items = (entries: Folder[]): JSX.Element => (
    <For each={entries}>
      {(folder) => (
        <nav.Item class="tree-item" value={folder.value} label={folder.label} branch={folder.children !== undefined}>
          <div class="option">
            <Show when={folder.children}>
              <nav.Indicator>▸</nav.Indicator>
            </Show>
            <nav.Label data-folder={folder.value}>{folder.label}</nav.Label>
          </div>
          <Show when={folder.children}>{(children) => <nav.Group class="tree-group">{items(children())}</nav.Group>}</Show>
        </nav.Item>
      )}
    </For>
  );
  return (
    <div class="page">
      <nav.Root aria-label="Ordner" data-testid="tree">
        {items(folders)}
      </nav.Root>
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
        <output data-testid="opened">{opened()}</output>
      </div>
    </div>
  );
}
