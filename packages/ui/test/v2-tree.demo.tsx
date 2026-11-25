import { createSignal } from "solid-js";
import { Nav, type NavTreeNode, Pane, Table, Workspace } from "../src/v2";

// Files as a tree, with invented folders: the sidebar's folder tree and the same folders as rows of a table.
// - "Entwürfe" (level 4) is the open folder, so the way to it starts open, also in the server's markup;
// - "Archiv" loads its children on the first open (they come when `window.__release()` is called);
// - "Fernablage" fails to load once, then loads;
// - "Fotos" has 10 000 children, 50 at a time, behind "Weitere … laden";
// - "Tief" is twelve levels deep with long names;
// - a folder's "…" lands its deed in `window.__treeDeeds`.

declare global {
  interface Window {
    __release?: () => void;
    __treeDeeds?: string[];
    __loads?: string[];
    __open?: (key: string) => void;
  }
}

type Folder = { key: string; name: string; size?: string; children?: Folder[]; branch?: boolean };

const PHOTOS = 10_000;
const PAGE = 50;
const photo = (index: number): Folder => ({ key: `foto-${index}`, name: `IMG_${String(index + 1).padStart(5, "0")}.jpg`, size: "3,2 MB" });

const deep = (level: number): Folder =>
  level > 12
    ? { key: `tief-${level}`, name: "Ganz unten.pdf", size: "12 KB" }
    : {
        key: `tief-${level}`,
        name: level === 1 ? "Tief" : `Ebene ${level} mit einem sehr langen Ordnernamen, der nicht in die Leiste passt`,
        children: [deep(level + 1)],
      };

const start = (): Folder[] => [
  {
    key: "projekte",
    name: "Projekte",
    children: [
      {
        key: "website",
        name: "Website",
        children: [
          { key: "texte", name: "Texte", children: [{ key: "entwuerfe", name: "Entwürfe", children: [] }] },
          { key: "bilder", name: "Bilder", children: [] },
        ],
      },
      { key: "messe", name: "Messe 2027", children: [] },
    ],
  },
  { key: "archiv", name: "Archiv", branch: true },
  { key: "fernablage", name: "Fernablage", branch: true },
  { key: "fotos", name: "Fotos", children: Array.from({ length: PAGE }, (_, index) => photo(index)) },
  deep(1),
  { key: "notiz", name: "Notiz.txt", size: "2 KB" },
];

/** The tree with `change` applied to the folder `key`. */
const update = (list: Folder[], key: string, change: (folder: Folder) => Folder): Folder[] =>
  list.map((folder) =>
    folder.key === key ? change(folder) : folder.children ? { ...folder, children: update(folder.children, key, change) } : folder,
  );

export function Demo() {
  const [folders, setFolders] = createSignal(start());
  const [current, setCurrent] = createSignal("entwuerfe");
  const [tableCurrent, setTableCurrent] = createSignal<string>();
  let failedOnce = false;
  const waiting: (() => void)[] = [];
  if (typeof window !== "undefined") {
    window.__release = () => waiting.splice(0).forEach((release) => release());
    window.__open = setCurrent;
  }
  const did = (deed: string) => () => {
    window.__treeDeeds = [...(window.__treeDeeds ?? []), deed];
  };
  const load = (key: string): Promise<void> => {
    window.__loads = [...(window.__loads ?? []), key];
    if (key === "fernablage" && !failedOnce) {
      failedOnce = true;
      return Promise.reject(new Error("offline"));
    }
    return new Promise<void>((resolve) => {
      waiting.push(() => {
        setFolders(update(folders(), key, (folder) => ({ ...folder, children: [{ key: `${key}-2025`, name: "2025", children: [] }] })));
        resolve();
      });
    });
  };
  const loadMore = async (key: string | null) => {
    if (key !== "fotos") return;
    setFolders(
      update(folders(), "fotos", (folder) => {
        const have = folder.children?.length ?? 0;
        return { ...folder, children: [...(folder.children ?? []), ...Array.from({ length: PAGE }, (_, index) => photo(have + index))] };
      }),
    );
  };
  const photosLeft = () => PHOTOS - (folders().find((folder) => folder.key === "fotos")?.children?.length ?? 0);
  const node = (folder: Folder): NavTreeNode => ({
    key: folder.key,
    label: folder.name,
    icon: folder.children !== undefined || folder.branch ? "folder" : "file",
    href: `#${folder.key}`,
    branch: folder.branch,
    children: folder.children?.filter((child) => child.children !== undefined || child.branch).map(node),
    more: folder.key === "fotos" && photosLeft() > 0 ? photosLeft() : undefined,
    menu: [
      { label: "Umbenennen", icon: "pencil", onClick: did(`rename:${folder.key}`) },
      { label: "Löschen", icon: "trash", danger: true, onClick: did(`delete:${folder.key}`) },
    ],
  });
  return (
    <Workspace
      sidebar={
        <Nav
          title="Dateien"
          icon="folder"
          groups={[
            { items: [{ label: "Zuletzt", icon: "clock", href: "#zuletzt" }] },
            {
              label: "Ordner",
              tree: {
                label: "Ordner",
                items: folders().map(node),
                current: current(),
                load: (key) => load(key),
                loadMore,
              },
            },
          ]}
        />
      }
    >
      <Pane label="Dateien">
        <Table
          label="Dateien als Baum"
          columns={[
            { title: "Name", cell: (folder: Folder) => folder.name, width: { min: 200, default: 420 } },
            { title: "Größe", cell: (folder: Folder) => folder.size ?? "–", align: "end", width: { min: 80, default: 120 } },
          ]}
          rows={folders()}
          rowKey={(folder) => folder.key}
          current={tableCurrent()}
          open={(folder) => ({ onOpen: () => setTableCurrent(folder.key) })}
          phone={(folder) => ({ lines: [folder.name, folder.size ?? "Ordner"] })}
          tree={{
            children: (folder) => folder.children,
            branch: (folder) => folder.children !== undefined || folder.branch === true,
            load: (folder) => load(folder.key),
            more: (folder) => (folder?.key === "fotos" && photosLeft() > 0 ? photosLeft() : undefined),
            loadMore: (folder) => loadMore(folder?.key ?? null),
          }}
        />
      </Pane>
    </Workspace>
  );
}
