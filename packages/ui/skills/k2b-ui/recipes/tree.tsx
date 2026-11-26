// Recipe: folders as a tree. The sidebar's `Nav` group holds the storages and their folders, each with its mark and
// count; the table shows the open folder's content as rows in levels, each with the mark of its kind, its owner and how
// it is shared. Both load a folder's children the first time it opens and page a long level.
// The open folder comes from the address: its way stands open in the tree, on the server's page too.
import { Bar, Button, Chip, Icon, Inline, Input, Nav, type NavTreeNode, Pane, Path, StatusRow, Table, Text, Workspace } from "@k2b/ui/v2";

// The app this screen belongs to: its colour tints the page and marks it in the host's rail.
export const app = { name: "Dateien", color: "#2563eb", icon: "files" };

// One mark per kind of entry, the same in the tree, the table and every sentence.
const type = {
  folder: { icon: "folder", color: "#c2410c" },
  text: { icon: "markdown", color: "#52525b" },
  photo: { icon: "photo", color: "#be185d" },
  pdf: { icon: "file-type-pdf", color: "#dc2626" },
  sheet: { icon: "file-spreadsheet", color: "#15803d" },
  plan: { icon: "vector", color: "#0284c7" },
};
const people = {
  felix: { name: "Felix Thal" },
  jonas: { name: "Jonas Kern" },
  mira: { name: "Mira Solberg" },
  sami: { name: "Sami Yilmaz" },
};
const sharing = {
  team: { icon: "users", label: "Team" },
  link: { icon: "link", label: "Link" },
  private: { icon: "lock", label: "Nur ich" },
};

type Entry = {
  id: string;
  name: string;
  kind: keyof typeof type;
  owner: { name: string };
  shared: keyof typeof sharing;
  size: string;
  changed: string;
  children?: Entry[];
  folder?: boolean;
  /** waits for someone: a state with colour and word */
  state?: { status: "warn" | "ok"; label: string };
};

const content: Entry[] = [
  {
    id: "aufmass",
    name: "Aufmaß",
    kind: "folder",
    owner: people.felix,
    shared: "team",
    size: "6 Dateien",
    changed: "heute, 08:10",
    children: [
      {
        id: "plan-eg",
        name: "Grundriss EG.dxf",
        kind: "plan",
        owner: people.felix,
        shared: "team",
        size: "1,8 MB",
        changed: "heute, 08:10",
      },
      { id: "masse", name: "Maße Küche.xlsx", kind: "sheet", owner: people.sami, shared: "team", size: "48 KB", changed: "gestern" },
      { id: "foto-wand", name: "Wand Nord.jpg", kind: "photo", owner: people.felix, shared: "team", size: "4,2 MB", changed: "gestern" },
    ],
  },
  {
    id: "angebote",
    name: "Angebote",
    kind: "folder",
    owner: people.mira,
    shared: "link",
    size: "4 Dateien",
    changed: "21.11.2026",
    children: [
      {
        id: "angebot-118",
        name: "Angebot 2026-118.pdf",
        kind: "pdf",
        owner: people.mira,
        shared: "link",
        size: "312 KB",
        changed: "heute, 08:31",
        state: { status: "warn", label: "Unterschreiben" },
      },
      {
        id: "angebot-112",
        name: "Angebot 2026-112.pdf",
        kind: "pdf",
        owner: people.mira,
        shared: "link",
        size: "298 KB",
        changed: "14.11.2026",
      },
    ],
  },
  {
    id: "fotos",
    name: "Fotos Baustelle",
    kind: "folder",
    owner: people.jonas,
    shared: "link",
    size: "48 Dateien",
    changed: "gestern",
    folder: true,
  },
  {
    id: "notizen",
    name: "Notizen Kundentermin.md",
    kind: "text",
    owner: people.mira,
    shared: "private",
    size: "3 KB",
    changed: "20.11.2026",
  },
  {
    id: "material",
    name: "Materialliste.xlsx",
    kind: "sheet",
    owner: people.sami,
    shared: "team",
    size: "48 KB",
    changed: "gestern, 11:48",
  },
  {
    id: "front",
    name: "Ansicht Front Eiche.jpg",
    kind: "photo",
    owner: people.felix,
    shared: "link",
    size: "4,2 MB",
    changed: "heute, 09:42",
  },
];

// The storages and folders of the sidebar: only folders, the way to the open one loaded.
const folders: NavTreeNode[] = [
  { key: "meine", label: "Meine Dateien", icon: "user", color: "#475569", href: "/files/meine", branch: true },
  {
    key: "werkstatt",
    label: "Werkstatt",
    icon: "tool",
    color: "#c2410c",
    href: "/files/werkstatt",
    children: [
      {
        key: "projekte",
        label: "Projekte",
        icon: "folder",
        href: "/files/projekte",
        count: 3,
        children: [
          { key: "lindqvist", label: "Küche Lindqvist", icon: "folder", href: "/files/lindqvist", branch: true, dot: "warn" },
          { key: "oswald", label: "Bad Oswald", icon: "folder", href: "/files/oswald", branch: true },
          { key: "winter", label: "Treppe Winter", icon: "folder", href: "/files/winter", branch: true },
        ],
      },
      { key: "vorlagen", label: "Vorlagen", icon: "folder", href: "/files/vorlagen", branch: true },
    ],
  },
  { key: "buero", label: "Büro", icon: "building-store", color: "#0e7490", href: "/files/buero", branch: true },
  // a level of 2 400 folders: the first 50 are loaded, "Weitere laden" brings the next
  { key: "fotoarchiv", label: "Fotoarchiv", icon: "photo", color: "#be185d", href: "/files/fotoarchiv", branch: true, more: 2350 },
];

export default function FilesTree() {
  return (
    <Workspace
      sidebar={
        <Nav
          title="Dateien"
          icon="files"
          groups={[
            {
              items: [
                { label: "Zuletzt", icon: "clock", href: "/files/zuletzt" },
                { label: "Favoriten", icon: "star", href: "/files/favoriten" },
                { label: "Freigaben", icon: "share", count: "2 neu", dot: "ok", href: "/files/freigaben" },
              ],
            },
            {
              label: "Ablagen",
              tree: {
                label: "Ablagen",
                items: folders,
                current: "lindqvist",
                // the app fetches the children and puts them into `items`; a rejection marks the folder failed
                load: async () => {},
                loadMore: async () => {},
              },
            },
          ]}
          quota={{ label: "Werkstatt", value: 38.2, of: 100, text: "38,2 von 100 GB" }}
          foot={[{ label: "Papierkorb", icon: "trash", href: "/files/papierkorb" }]}
        />
      }
      head={
        <Bar
          start={
            <Path
              label="Ort"
              items={[
                { label: "Werkstatt", href: "/files/werkstatt" },
                { label: "Projekte", href: "/files/projekte" },
                { label: "Küche Lindqvist" },
              ]}
            />
          }
          end={
            <>
              <Input type="search" icon="search" label="In diesem Ordner" placeholder="In diesem Ordner" />
              <Button variant="primary" icon="upload">
                Hochladen
              </Button>
            </>
          }
        />
      }
      primary={{ label: "Hochladen", icon: "upload" }}
    >
      <Pane
        label="Küche Lindqvist"
        status={
          <StatusRow
            lead="1 Angebot wartet auf Unterschrift"
            facts={[{ value: 13, after: "Einträge" }, { value: "186 MB" }]}
            filters={<Chip status="warn">Unterschreiben</Chip>}
          />
        }
      >
        <Table
          label="Inhalt von Küche Lindqvist"
          columns={[
            {
              title: "Name",
              cell: (entry: Entry) => entry.name,
              // each entry leads with the mark of its kind
              mark: (entry: Entry) => type[entry.kind],
              width: { min: 200, default: 330 },
            },
            {
              title: "Von",
              cell: (entry: Entry) => entry.owner.name,
              avatar: (entry: Entry) => entry.owner,
              width: { min: 110, default: 190 },
              drop: true,
            },
            {
              title: "Freigabe",
              cell: (entry: Entry) =>
                entry.state ? (
                  <Chip status={entry.state.status}>{entry.state.label}</Chip>
                ) : (
                  <Inline>
                    <Icon name={sharing[entry.shared].icon} />
                    <Text>{sharing[entry.shared].label}</Text>
                  </Inline>
                ),
              width: { min: 130, default: 210 },
              drop: true,
            },
            { title: "Geändert", cell: (entry: Entry) => entry.changed, width: { min: 90, default: 160 }, drop: true },
            { title: "Größe", cell: (entry: Entry) => entry.size, align: "end", width: { min: 80, default: 130 } },
          ]}
          rows={content}
          rowKey={(entry) => entry.id}
          // the open file: its row is tinted, and the way to it starts open
          current="angebot-118"
          open={(entry) => ({ href: `/files/${entry.id}` })}
          phone={(entry) => ({
            mark: type[entry.kind],
            lines: [entry.name, `${entry.size} · ${entry.changed} · ${sharing[entry.shared].label}`],
            marks: entry.state ? <Chip status={entry.state.status}>{entry.state.label}</Chip> : undefined,
          })}
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
