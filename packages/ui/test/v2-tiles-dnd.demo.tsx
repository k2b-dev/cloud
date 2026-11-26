import { createSignal } from "solid-js";
import { type DragMove, Nav, type NavTreeNode, Pane, Table, Tiles, Workspace } from "../src/v2";

// Files with invented data: the folder tree in the sidebar, the open folder's files as picture tiles and as a table.
// Every list shares the drag scope "files": a tile or a row is let go over a folder of the tree, the table or the
// tiles. Moves land in `window.__moves`, files from the computer in `window.__files`; the
// tiles are media tiles. Pictures are small inline SVGs; one address is broken, one tile has none.
// - "Gesperrt.pdf" cannot be moved (a selection with it moves nothing);
// - `window.__select(keys)` changes the selection, `window.__refuseAll = true` makes every folder refuse;
// - each tile's menu ("Verschieben nach …", "Löschen") lands its deed in `window.__deeds`;
// - a second list of scope "other" has a folder with the same key "belege", which must never take a file of "files".

declare global {
  interface Window {
    __moves?: string[];
    __files?: string[];
    __select?: (keys: readonly string[]) => void;
    __refuseAll?: boolean;
    __deeds?: string[];
    __growSelection?: (key: string) => void;
  }
}

type Entry = { key: string; name: string; folder?: boolean; image?: string; size?: string };

const picture = (color: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="${color}"/></svg>`)}`;

const start: Entry[] = [
  { key: "belege", name: "Belege", folder: true },
  { key: "fotos", name: "Fotos", folder: true },
  { key: "messe", name: "Messestand.jpg", image: picture("#7aa2d6"), size: "3,2 MB" },
  { key: "werkstatt", name: "Werkstatt mit einem sehr langen Dateinamen, der nicht passt.jpg", image: picture("#d6a27a"), size: "4,1 MB" },
  { key: "kaputt", name: "Beschädigt.png", image: "data:image/png;base64,AAAA", size: "12 KB" },
  { key: "gesperrt", name: "Gesperrt.pdf", size: "40 KB" },
  { key: "angebot", name: "Angebot.pdf", size: "220 KB" },
];

const tree: NavTreeNode[] = [
  {
    key: "projekte",
    label: "Projekte",
    icon: "folder",
    href: "#projekte",
    children: [{ key: "website", label: "Website", icon: "folder", href: "#website" }],
  },
  {
    key: "archiv",
    label: "Archiv",
    icon: "folder",
    href: "#archiv",
    children: [{ key: "archiv-2025", label: "2025", icon: "folder", href: "#archiv-2025" }],
  },
];

export function Demo() {
  const [entries, setEntries] = createSignal(start);
  const [selected, setSelected] = createSignal<readonly string[]>([]);
  const [current, setCurrent] = createSignal<string>();
  if (typeof window !== "undefined") {
    window.__select = setSelected;
    // the app changes its selection array in place while a drag is under way
    window.__growSelection = (key) => (selected() as string[]).push(key);
  }
  const did = (deed: string) => () => {
    window.__deeds = [...(window.__deeds ?? []), deed];
  };
  const name = (key: string) =>
    entries().find((entry) => entry.key === key)?.name ??
    [...tree, ...tree.flatMap((node) => node.children ?? [])].find((node) => node.key === key)?.label ??
    key;
  const folders = new Set(["projekte", "website", "archiv", "archiv-2025", "belege", "fotos"]);
  const drag: DragMove = {
    scope: "files",
    label: name,
    draggable: (key) => key !== "gesperrt",
    target: (key) => folders.has(key),
    // "Fotos" takes only pictures (a folder never goes into itself or a folder in it: the lists refuse that)
    accepts: (keys, target) =>
      !window.__refuseAll && (target !== "fotos" || keys.every((key) => entries().find((entry) => entry.key === key)?.image)),
    onDrop: (keys, target) => {
      window.__moves = [...(window.__moves ?? []), `${keys.join("+")}>${target}`];
      setEntries(entries().filter((entry) => !keys.includes(entry.key) || folders.has(entry.key)));
      setSelected([]);
    },
    onFiles: (files, target) => {
      window.__files = [...(window.__files ?? []), `${files.map((file) => file.name).join("+")}>${target}`];
    },
  };
  return (
    <Workspace sidebar={<Nav title="Dateien" icon="folder" groups={[{ label: "Ordner", tree: { label: "Ordner", items: tree, drag } }]} />}>
      <Pane label="Dateien">
        <Tiles
          variant="media"
          label="Dateien als Kacheln"
          items={entries().map((entry) => ({
            key: entry.key,
            icon: entry.folder ? "folder" : entry.image ? "photo" : "file-type-pdf",
            title: entry.name,
            meta: entry.size,
            image: entry.image,
            color: entry.folder ? "#ca8a04" : entry.image ? "#0891b2" : "#dc2626",
            href: `#${entry.key}`,
            menu: [
              { label: "Verschieben nach …", icon: "folder-symlink", onClick: did(`move:${entry.key}`) },
              { label: "Löschen", icon: "trash", danger: true, onClick: did(`delete:${entry.key}`) },
            ],
          }))}
          select={{
            selected: selected(),
            onChange: (key, on) => setSelected(on ? [...selected(), key] : selected().filter((other) => other !== key)),
          }}
          drag={drag}
        />
        <Tiles
          variant="media"
          label="Verknüpfungen"
          items={[{ key: "projekte", icon: "link", title: "Projekte (Verknüpfung)", color: "#ca8a04", href: "#verknuepfung" }]}
          // same scope, but here "projekte" is a link, not a folder: it never takes a drop
          drag={{ ...drag, target: () => false }}
        />
        <Tiles
          variant="media"
          label="Andere Ablage"
          items={[{ key: "belege", icon: "folder", title: "Belege (andere Ablage)", color: "#ca8a04", href: "#andere" }]}
          drag={{ scope: "other", label: () => "Belege (andere Ablage)", target: () => true, onDrop: did("other-drop") }}
        />
        <Table
          label="Dateien als Tabelle"
          columns={[
            { title: "Name", cell: (entry: Entry) => entry.name, width: { min: 200, default: 360 } },
            { title: "Größe", cell: (entry: Entry) => entry.size ?? "–", align: "end", width: { min: 80, default: 120 } },
          ]}
          rows={entries()}
          rowKey={(entry) => entry.key}
          select={{ selected: selected(), onChange: setSelected, all: "Alle Dateien", row: (entry) => entry.name }}
          current={current()}
          open={(entry) => ({ onOpen: () => setCurrent(entry.key) })}
          drag={drag}
        />
      </Pane>
    </Workspace>
  );
}
