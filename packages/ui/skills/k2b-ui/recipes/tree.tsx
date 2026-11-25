// Recipe: folders as a tree. The sidebar's `Nav` group holds the folder tree, the table shows the open folder's
// content as rows in levels. Both load a folder's children the first time it opens and page a long level.
// The open folder comes from the address: its way stands open in the tree, on the server's page too.
import { Bar, Button, Nav, type NavTreeNode, Pane, Path, StatusRow, Table, Workspace } from "@k2b/ui/v2";

type Entry = { id: string; name: string; size?: string; changed: string; children?: Entry[]; folder?: boolean };

const content: Entry[] = [
  {
    id: "entwuerfe",
    name: "Entwürfe",
    changed: "heute",
    children: [
      { id: "startseite", name: "Startseite.md", size: "14 KB", changed: "heute" },
      { id: "impressum", name: "Impressum.md", size: "3 KB", changed: "gestern" },
    ],
  },
  { id: "bilder", name: "Bilder", changed: "12. Nov.", folder: true },
  { id: "fotos", name: "Messefotos", changed: "3. Nov.", children: [{ id: "f1", name: "IMG_00001.jpg", size: "3,2 MB", changed: "3. Nov." }] },
  { id: "angebot", name: "Angebot Lackfabrik Nordhaus.pdf", size: "220 KB", changed: "28. Okt." },
];

// The folders of the sidebar: only folders, the way to the open one loaded.
const folders: NavTreeNode[] = [
  {
    key: "projekte",
    label: "Projekte",
    icon: "folder",
    href: "/files/projekte",
    children: [
      {
        key: "website",
        label: "Website",
        icon: "folder",
        href: "/files/website",
        children: [
          { key: "texte", label: "Texte", icon: "folder", href: "/files/texte", branch: true },
          { key: "bilder-web", label: "Bilder", icon: "folder", href: "/files/bilder-web", branch: true },
        ],
      },
      { key: "messe", label: "Messe 2027", icon: "folder", href: "/files/messe", branch: true },
    ],
  },
  { key: "archiv", label: "Archiv", icon: "archive", href: "/files/archiv", branch: true },
  // a level of 2 400 folders: the first 50 are loaded, "Weitere laden" brings the next
  { key: "kunden", label: "Kunden", icon: "folder", href: "/files/kunden", branch: true, more: 2350 },
];

export default function FilesTree() {
  return (
    <Workspace
      sidebar={
        <Nav
          title="Dateien"
          icon="folder"
          groups={[
            {
              items: [
                { label: "Zuletzt", icon: "clock", href: "/files/zuletzt" },
                { label: "Favoriten", icon: "star", href: "/files/favoriten" },
              ],
            },
            {
              label: "Ordner",
              tree: {
                label: "Ordner",
                items: folders,
                current: "website",
                // the app fetches the children and puts them into `items`; a rejection marks the folder failed
                load: async () => {},
                loadMore: async () => {},
              },
            },
          ]}
        />
      }
      head={
        <Bar
          start={<Path label="Ort" items={[{ label: "Projekte", href: "/files/projekte" }, { label: "Website" }]} />}
          end={
            <Button variant="primary" icon="upload">
              Hochladen
            </Button>
          }
        />
      }
      primary={{ label: "Hochladen", icon: "upload" }}
    >
      <Pane label="Website" status={<StatusRow lead="4 Einträge" facts={[{ value: "3,4 MB" }]} />}>
        <Table
          label="Inhalt von Website"
          columns={[
            { title: "Name", cell: (entry: Entry) => entry.name, width: { min: 220, default: 420 } },
            { title: "Geändert", cell: (entry: Entry) => entry.changed, width: { min: 100, default: 140 }, drop: true },
            { title: "Größe", cell: (entry: Entry) => entry.size ?? "–", align: "end", width: { min: 80, default: 110 } },
          ]}
          rows={content}
          rowKey={(entry) => entry.id}
          // the open file: its row is tinted, and the way to it starts open
          current="startseite"
          open={(entry) => ({ href: `/files/${entry.id}` })}
          phone={(entry) => ({ lines: [entry.name, entry.size ?? "Ordner"], time: entry.changed })}
          tree={{
            children: (entry) => entry.children,
            branch: (entry) => entry.children !== undefined || entry.folder === true,
            load: async () => {},
          }}
        />
      </Pane>
    </Workspace>
  );
}
