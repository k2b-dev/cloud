// break-ui worst case for trees and picture tiles: twelve levels, long and unbroken names, a level of 10 000 behind
// "Weitere laden", a failed and a loading folder, broken and missing pictures, many selected tiles.
import { Nav, type NavTreeNode, Pane, Section, Table, Tiles, Workspace } from "../src/v2";

const long = "Projektunterlagen_Kundenakte_Lackfabrik_Nordhaus_2027_final_wirklich_final_v12";
const deep = (level: number): NavTreeNode => ({
  key: `l${level}`,
  label: level % 2 ? `Ebene ${level} ${long}` : `Ebene ${level}`,
  icon: "folder",
  href: `#l${level}`,
  count: level === 12 ? 9999 : undefined,
  children: level < 12 ? [deep(level + 1)] : [],
});
const tree: NavTreeNode[] = [
  deep(1),
  {
    key: "fotos",
    label: "Fotos",
    icon: "folder",
    href: "#fotos",
    children: Array.from({ length: 6 }, (_, i) => ({ key: `f${i}`, label: `Ordner ${i + 1}`, icon: "folder", href: `#f${i}` })),
    more: 9994,
  },
  { key: "x", label: "X", icon: "folder", href: "#x", branch: true },
  { key: "emoji", label: "📁 Ablage 日本語 ملفات", icon: "folder", href: "#emoji", branch: true },
];

type Row = { key: string; name: string; size: string; children?: Row[] };
const deepRow = (level: number): Row => ({
  key: `r${level}`,
  name: `${level}. ${long}`,
  size: "–",
  children: level < 12 ? [deepRow(level + 1)] : [],
});

const swatch = (color: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="${color}"/></svg>`)}`;

export default function WorstCase() {
  return (
    <Workspace
      sidebar={
        <Nav
          title="Dateien"
          icon="folder"
          groups={[
            { label: "Ordner", tree: { label: "Ordner", items: tree, current: "l12", loadMore: async () => {}, load: async () => {} } },
          ]}
        />
      }
    >
      <Pane label="Worst case">
        <Section icon="table" title="Baum in der Tabelle">
          <Table
            label="Tief"
            columns={[
              { title: "Name", cell: (row: Row) => row.name, width: { min: 200, default: 520 } },
              { title: "Größe", cell: (row: Row) => row.size, align: "end", width: { min: 80, default: 100 } },
            ]}
            rows={[
              deepRow(1),
              { key: "viele", name: "Viele", size: "10 000", children: [{ key: "v1", name: "IMG_00001.jpg", size: "3 MB" }] },
            ]}
            rowKey={(row) => row.key}
            current="r12"
            phone={(row) => ({ lines: [row.name, row.size] })}
            tree={{
              children: (row) => row.children,
              branch: (row) => row.children !== undefined,
              more: (row) => (row?.key === "viele" ? 9999 : undefined),
              loadMore: async () => {},
            }}
          />
        </Section>
        <Section icon="photo" title="Kacheln">
          <Tiles
            label="Kacheln"
            pictures="small"
            items={[
              { key: "a", icon: "photo", title: long, meta: "12,4 MB", image: swatch("#8fb3d9") },
              { key: "b", icon: "photo", title: "Hochformat.jpg", meta: "2 MB", image: swatch("#d98f8f") },
              { key: "c", icon: "photo", title: "Kaputt.png", meta: "0 B", image: "data:image/png;base64,AAAA" },
              { key: "d", icon: "file-type-pdf", title: "A", meta: undefined },
              { key: "e", icon: "folder", title: "📁 日本語 ملفات", meta: "9 999 Dateien" },
            ]}
            select={{ selected: ["a", "c"], onChange: () => {} }}
          />
        </Section>
      </Pane>
    </Workspace>
  );
}
