import { createSignal, For, type JSX, Show } from "solid-js";
import { type TreeParts, useListbox, useTree } from "../../src/v2/behavior/lists";

const mails = [
  { value: "m1", label: "Angebot Eichenplatten" },
  { value: "m2", label: "Unterlagen drittes Quartal" },
  { value: "m3", label: "Termin Abholung", disabled: true },
  { value: "m4", label: "Lieferung Freitag" },
  { value: "m5", label: "Fotos vom Tisch" },
];

type Folder = { value: string; label: string; children?: Folder[]; branch?: boolean };
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
  // A second tree: its current page is nested (level 3), so its ancestors are expanded from the start, and one branch
  // loads its children and fails.
  const nested = useTree(() => ({
    mode: "none",
    current: "spam",
    defaultExpanded: ["more", "hidden"],
    loadChildren: (value) => (value === "remote" ? Promise.reject(new Error("offline")) : undefined),
  }));
  const tree = (parts: TreeParts, attribute: string, entries: Folder[]): JSX.Element => (
    <For each={entries}>
      {(folder) => (
        <parts.Item class="tree-item" value={folder.value} label={folder.label} branch={folder.branch ?? folder.children !== undefined}>
          <div class="option">
            <Show when={folder.branch ?? folder.children}>
              <parts.Indicator>▸</parts.Indicator>
            </Show>
            <parts.Label {...{ [attribute]: folder.value }}>{folder.label}</parts.Label>
          </div>
          <Show when={folder.children}>
            {(children) => <parts.Group class="tree-group">{tree(parts, attribute, children())}</parts.Group>}
          </Show>
        </parts.Item>
      )}
    </For>
  );
  const items = (entries: Folder[]) => tree(nav, "data-folder", entries);
  return (
    <div class="page">
      <div>
        <nav.Root aria-label="Ordner" data-testid="tree">
          {items(folders)}
        </nav.Root>
        <nested.Root aria-label="Weitere Ordner" data-testid="nested-tree">
          {tree(nested, "data-nested", [...folders.slice(2), { value: "remote", label: "Fernordner", branch: true }])}
        </nested.Root>
      </div>
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
