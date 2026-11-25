import { createSignal } from "solid-js";
import { type DragMove, Nav, type NavTreeNode, Pane, Table, Tiles, Workspace } from "../src/v2";

// Files with invented data: the folder tree in the sidebar, the open folder's files as picture tiles and as a table.
// Every list shares the drag scope "files": a tile or a row is let go over a folder of the tree, the table or the
// tiles. Moves land in `window.__moves`, files from the computer in `window.__files`; `window.__size(…)` switches
// the tile size. Pictures are small inline SVGs; one address is broken, one tile has none.

declare global {
  interface Window {
    __moves?: string[];
    __files?: string[];
    __size?: (size: "small" | "medium" | "large") => void;
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
  const [size, setSize] = createSignal<"small" | "medium" | "large">("medium");
  const [selected, setSelected] = createSignal<readonly string[]>([]);
  const [current, setCurrent] = createSignal<string>();
  if (typeof window !== "undefined") window.__size = setSize;
  const name = (key: string) =>
    entries().find((entry) => entry.key === key)?.name ??
    [...tree, ...tree.flatMap((node) => node.children ?? [])].find((node) => node.key === key)?.label ??
    key;
  const folders = new Set(["projekte", "website", "archiv", "archiv-2025", "belege", "fotos"]);
  const drag: DragMove = {
    scope: "files",
    label: name,
    target: (key) => folders.has(key),
    // a folder never goes into itself; "Fotos" takes only pictures
    accepts: (keys, target) => target !== "fotos" || keys.every((key) => entries().find((entry) => entry.key === key)?.image),
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
          label="Dateien als Kacheln"
          pictures={size()}
          items={entries().map((entry) => ({
            key: entry.key,
            icon: entry.folder ? "folder" : entry.image ? "photo" : "file-type-pdf",
            title: entry.name,
            meta: entry.size,
            image: entry.image,
            color: entry.folder ? "#ca8a04" : entry.image ? "#0891b2" : "#dc2626",
            onOpen: () => setCurrent(entry.key),
          }))}
          current={current()}
          select={{ selected: selected(), onChange: setSelected }}
          drag={drag}
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
