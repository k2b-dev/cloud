// Recipe: a folder of files. Two full-width rows above list and detail: the path with the deeds, then the filters with
// the count, the order and the display. Every file leads with its thumbnail or the mark of its type; the open file
// shows a large preview beside the list. In the grid, photos and pages stand as media tiles that people select.
import {
  Bar,
  Button,
  Facts,
  FilterBar,
  Icon,
  Input,
  ListOrder,
  Menu,
  Nav,
  Pane,
  Path,
  Preview,
  Row,
  Section,
  StatusRow,
  Table,
  Text,
  Tiles,
  Workspace,
} from "@k2b/ui/v2";
import { defineListQuery, field, type ListQueryStateOf } from "@k2b/ui/v2/list-query";
import { createSignal } from "solid-js";

// Small drawings stand in for the thumbnails the server would send.
const picture = (body: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120" viewBox="0 0 160 120">${body}</svg>`)}`;
const thumbs = {
  oak: picture(
    '<rect width="160" height="120" fill="#c99d66"/><g stroke="#a87d4c" stroke-width="2"><path d="M0 20h160M0 44h160M0 70h160M0 96h160"/></g><path d="M52 0v120M106 0v120M0 58h160" stroke="#5d4330" stroke-width="3"/>',
  ),
  kitchen: picture(
    '<rect width="160" height="120" fill="#ece7df"/><rect y="56" width="160" height="6" fill="#5d4330"/><rect y="62" width="160" height="58" fill="#a87d52"/><path d="M53 62v58M107 62v58" stroke="#5d4330" stroke-width="2"/><circle cx="124" cy="24" r="18" fill="#fff"/>',
  ),
  stone: picture(
    '<rect width="160" height="120" fill="#3f3f46"/><circle cx="30" cy="34" r="9" fill="#a1a1aa"/><circle cx="112" cy="70" r="6" fill="#71717a"/><circle cx="64" cy="96" r="12" fill="#d4d4d8"/><circle cx="136" cy="24" r="16" fill="#e4e4e7"/>',
  ),
  window: picture(
    '<rect width="160" height="120" fill="#d6d3d1"/><rect y="48" width="160" height="6" fill="#a8a29e"/><rect y="84" width="160" height="36" fill="#78716c"/><rect x="84" y="18" width="46" height="58" fill="#f5f5f4" stroke="#a8a29e" stroke-width="3"/>',
  ),
  page: picture(
    '<rect width="160" height="120" fill="#f4f4f5"/><rect x="42" y="12" width="76" height="108" fill="#fff"/><rect x="52" y="24" width="40" height="6" fill="#27272a"/><g fill="#d4d4d8"><rect x="52" y="40" width="56" height="4"/><rect x="52" y="50" width="50" height="4"/><rect x="52" y="60" width="56" height="4"/><rect x="52" y="70" width="36" height="4"/></g>',
  ),
  sheet: picture(
    '<rect width="160" height="120" fill="#f4f4f5"/><rect x="34" y="14" width="92" height="106" fill="#fff"/><rect x="34" y="14" width="92" height="14" fill="#15803d"/><g stroke="#e4e4e7"><path d="M57 28v92M80 28v92M103 28v92M34 44h92M34 60h92M34 76h92M34 92h92"/></g>',
  ),
  plan: picture(
    '<rect width="160" height="120" fill="#0f172a"/><rect x="34" y="20" width="92" height="80" fill="none" stroke="#38bdf8" stroke-width="2"/><path d="M80 20v80M34 64h92" stroke="#7dd3fc" stroke-width="2"/>',
  ),
};
const type = {
  folder: { icon: "folder", color: "#c2410c" },
  photo: { icon: "photo", color: "#be185d" },
  pdf: { icon: "file-type-pdf", color: "#dc2626" },
  sheet: { icon: "file-spreadsheet", color: "#15803d" },
  plan: { icon: "vector", color: "#0284c7" },
  text: { icon: "markdown", color: "#52525b" },
  video: { icon: "movie", color: "#475569" },
};
const people = {
  felix: { name: "Felix Thal" },
  jonas: { name: "Jonas Kern" },
  mira: { name: "Mira Solberg" },
  sami: { name: "Sami Yilmaz" },
};
type Sharing = "team" | "link" | "private";
const sharing = {
  team: { icon: "users", label: "Team" },
  link: { icon: "link", label: "Link" },
  private: { icon: "lock", label: "Nur ich" },
};

type Entry = {
  key: string;
  name: string;
  kind: keyof typeof type;
  image?: string;
  badge?: string;
  owner: { name: string };
  sharing: Sharing;
  changed: string;
  size: string;
  folder?: boolean;
};

const entries: Entry[] = [
  {
    key: "aufmass",
    name: "Aufmaß",
    kind: "folder",
    folder: true,
    owner: people.felix,
    sharing: "team",
    changed: "heute, 08:10",
    size: "6 Dateien",
  },
  {
    key: "fotos",
    name: "Fotos Baustelle",
    kind: "folder",
    folder: true,
    owner: people.jonas,
    sharing: "link",
    changed: "gestern",
    size: "48 Dateien",
  },
  {
    key: "front",
    name: "Ansicht Front Eiche.jpg",
    kind: "photo",
    image: thumbs.oak,
    owner: people.felix,
    sharing: "link",
    changed: "heute, 09:42",
    size: "4,2 MB",
  },
  {
    key: "angebot",
    name: "Angebot 2026-118.pdf",
    kind: "pdf",
    image: thumbs.page,
    badge: "PDF",
    owner: people.mira,
    sharing: "link",
    changed: "heute, 08:31",
    size: "312 KB",
  },
  {
    key: "dxf",
    name: "Aufmaß Küche Lindqvist.dxf",
    kind: "plan",
    image: thumbs.plan,
    badge: "DXF",
    owner: people.felix,
    sharing: "team",
    changed: "gestern, 17:05",
    size: "1,8 MB",
  },
  {
    key: "vorher",
    name: "Bestand Küche vorher.jpg",
    kind: "photo",
    image: thumbs.kitchen,
    owner: people.jonas,
    sharing: "team",
    changed: "gestern, 15:20",
    size: "5,6 MB",
  },
  {
    key: "material",
    name: "Materialliste.xlsx",
    kind: "sheet",
    image: thumbs.sheet,
    badge: "XLS",
    owner: people.sami,
    sharing: "team",
    changed: "gestern, 11:48",
    size: "48 KB",
  },
  {
    key: "granit",
    name: "Muster Arbeitsplatte Granit.jpg",
    kind: "photo",
    image: thumbs.stone,
    owner: people.felix,
    sharing: "team",
    changed: "22.11.2026",
    size: "3,1 MB",
  },
  {
    key: "fenster",
    name: "Fenster Nordseite.jpg",
    kind: "photo",
    image: thumbs.window,
    owner: people.jonas,
    sharing: "team",
    changed: "19.11.2026",
    size: "2,7 MB",
  },
  {
    key: "notizen",
    name: "Notizen Kundentermin.md",
    kind: "text",
    badge: "MD",
    owner: people.mira,
    sharing: "private",
    changed: "20.11.2026",
    size: "3 KB",
  },
  {
    key: "rundgang",
    name: "Rundgang Aufmaß.mp4",
    kind: "video",
    badge: "2:14",
    owner: people.jonas,
    sharing: "team",
    changed: "20.11.2026",
    size: "164 MB",
  },
];

// In the app this lives in a module of its own, imported by the server route and the island.
export const fileQuery = defineListQuery({
  key: "files",
  fields: {
    kind: field.choice({
      label: "Art",
      options: [
        { value: "photo", label: "Bild" },
        { value: "pdf", label: "PDF" },
        { value: "sheet", label: "Tabelle" },
      ],
      common: true,
    }),
    owner: field.choice({
      label: "Person",
      options: [
        { value: "felix", label: "Felix Thal" },
        { value: "mira", label: "Mira Solberg" },
        { value: "jonas", label: "Jonas Kern" },
      ],
      common: true,
    }),
  },
  sort: {
    options: { name: { label: "Name", directions: ["asc", "desc"] }, changed: { label: "Geändert", directions: ["desc", "asc"] } },
    default: { field: "name", direction: "asc" },
  },
});

// `grid`: the photos and pages as media tiles; `selecting`: three photos chosen in the grid.
type Props = { grid?: boolean; selected?: readonly string[] };

export default function Folder(props: Props) {
  const [state, setState] = createSignal<ListQueryStateOf<typeof fileQuery>>(fileQuery.parse("owner=felix,mira").state);
  const [selected, setSelected] = createSignal<readonly string[]>(props.selected ?? []);
  const toggle = (key: string, on: boolean) => setSelected((now) => (on ? [...now, key] : now.filter((each) => each !== key)));
  const files = entries.filter((entry) => !entry.folder);
  return (
    <Workspace
      sidebar={
        <Nav
          title="Dateien"
          icon="folders"
          groups={[
            {
              items: [
                { label: "Zuletzt", icon: "clock" },
                { label: "Favoriten", icon: "star" },
                { label: "Freigaben", icon: "share", count: "2 neu", dot: "ok" },
              ],
            },
            {
              label: "Ablagen",
              items: [
                { label: "Meine Dateien", icon: "user", color: "#475569" },
                { label: "Werkstatt", icon: "tool", color: "#c2410c" },
                { label: "Küche Lindqvist", icon: "folder", nested: true, current: true },
                { label: "Bad Oswald", icon: "folder", nested: true },
                { label: "Büro", icon: "building-store", color: "#0f766e" },
                { label: "Fotoarchiv", icon: "photo", color: "#db2777" },
              ],
            },
          ]}
          quota={{ label: "Werkstatt", value: 38.2, of: 100, text: "38,2 von 100 GB" }}
          foot={[{ label: "Papierkorb", icon: "trash" }]}
        />
      }
      head={
        <Bar
          start={
            <Path
              label="Ort"
              items={[{ label: "Werkstatt", href: "#werkstatt" }, { label: "Projekte", href: "#projekte" }, { label: "Küche Lindqvist" }]}
            />
          }
          end={
            <>
              <Input type="search" icon="search" label="In diesem Ordner" placeholder="In diesem Ordner" />
              <Button icon="folder-plus" label="Neuer Ordner" />
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
          selected().length > 0 ? (
            <StatusRow
              lead=""
              select={{ label: "Alle auswählen", checked: "mixed" }}
              selection={{
                count: `${selected().length} ausgewählt`,
                actions: [
                  { label: "Teilen", icon: "share" },
                  { label: "Verschieben", icon: "folder-symlink" },
                  { label: "Als ZIP laden", icon: "download" },
                  { label: "Löschen", icon: "trash" },
                ],
                clear: { label: "Auswahl aufheben", onClick: () => setSelected([]) },
              }}
            />
          ) : (
            <FilterBar
              query={fileQuery}
              state={state()}
              onChange={setState}
              icons={{ kind: "file", owner: "user" }}
              results="13 Einträge · 186 MB"
              end={
                <>
                  <ListOrder query={fileQuery} state={state()} onChange={setState} />
                  <Menu
                    icon={props.grid ? "layout-grid" : "list"}
                    items={[
                      { label: "Liste", icon: "list", checked: !props.grid },
                      { label: "Raster", icon: "layout-grid", checked: props.grid === true },
                    ]}
                  >
                    {props.grid ? "Raster" : "Liste"}
                  </Menu>
                </>
              }
            />
          )
        }
      >
        {props.grid ? (
          <Pane label="Dateien">
            <Tiles
              variant="media"
              label="Dateien"
              select={{ selected: selected(), onChange: toggle }}
              items={files.map((entry) => ({
                key: entry.key,
                ...type[entry.kind],
                title: entry.name,
                image: entry.image,
                kind: entry.badge,
                meta: entry.changed,
                people: [entry.owner],
                sign: sharing[entry.sharing],
                href: `#${entry.key}`,
              }))}
            />
          </Pane>
        ) : (
          <Pane.Split>
            <Pane label="Dateien">
              <Table
                label="Dateien"
                rows={entries}
                rowKey={(row) => row.key}
                select={{ selected: selected(), onChange: (keys) => setSelected(keys), all: "Alle Einträge", row: (row) => row.name }}
                current="front"
                open={(row) => ({ href: `#${row.key}` })}
                group={(row) =>
                  row.folder ? { key: "ordner", head: () => "Ordner", count: "2" } : { key: "dateien", head: () => "Dateien", count: "11" }
                }
                phone={(row) => ({
                  lines: [row.name, `${row.size} · ${row.changed} · ${sharing[row.sharing].label}`],
                  mark: { ...type[row.kind], image: row.image, kind: row.badge },
                })}
                columns={[
                  {
                    title: "Name",
                    width: { min: 200, default: 280 },
                    mark: (row) => ({ ...type[row.kind], image: row.image, kind: row.badge }),
                    cell: (row) => row.name,
                  },
                  {
                    title: "Von",
                    width: { min: 120, default: 140 },
                    avatar: (row) => row.owner,
                    cell: (row) => row.owner.name,
                    drop: true,
                  },
                  {
                    title: "Freigabe",
                    width: { min: 100, default: 110 },
                    cell: (row) => (
                      <Text>
                        <Icon name={sharing[row.sharing].icon} /> {sharing[row.sharing].label}
                      </Text>
                    ),
                    drop: true,
                  },
                  { title: "Geändert", width: { min: 100, default: 110 }, cell: (row) => row.changed, drop: true },
                  { title: "Größe", width: { min: 72, default: 90 }, align: "end", cell: (row) => row.size },
                ]}
              />
            </Pane>
            <Pane
              detail
              label="Ansicht Front Eiche.jpg"
              width={{ min: 320, default: 380 }}
              back={{ label: "Küche Lindqvist", href: "#" }}
              head={
                <Bar
                  start={
                    <Text type="body" weight="strong">
                      Ansicht Front Eiche.jpg
                    </Text>
                  }
                  end={
                    <>
                      <Button variant="ghost" icon="star" label="Favorit" pressed={false} />
                      <Button variant="ghost" icon="x" label="Schließen" href="#" />
                    </>
                  }
                />
              }
            >
              <Preview label="Vorschau von Ansicht Front Eiche.jpg" {...type.photo} image={thumbs.oak} kind="JPG" />
              <Bar
                start={
                  <>
                    <Button icon="external-link">Öffnen</Button>
                    <Button icon="share">Teilen</Button>
                    <Button icon="download">Laden</Button>
                  </>
                }
                end={<Text type="meta">JPG · 4,2 MB</Text>}
              />
              <Facts
                items={[
                  { label: "Geändert", value: "Felix Thal · heute, 09:42" },
                  { label: "Aufgenommen", value: "24.11.2026 · 4032 × 3024" },
                  { label: "Ort", value: "Werkstatt › Projekte › Küche Lindqvist" },
                ]}
              />
              <Section icon="share" title="Freigabe" count={2} actions={[{ label: "Verwalten" }]}>
                <Row mark={{ icon: "users", color: "#c2410c" }} lines={["Team Werkstatt"]} time="Bearbeiten" />
                <Row
                  avatar={{ name: "Petra Lindqvist" }}
                  lines={["Petra Lindqvist · Link", "Ansehen · läuft ab 15.12. · 3× geöffnet"]}
                  end={<Button variant="ghost" icon="copy" label="Link kopieren" />}
                />
              </Section>
              <Section icon="history" title="Versionen" count={3} more={{ label: "Alle Versionen", forward: true }}>
                <Row avatar={people.felix} lines={["heute, 09:42"]} meta="aktuell" time="4,2 MB" />
                <Row avatar={people.felix} lines={["gestern, 17:12"]} time="4,0 MB" />
              </Section>
            </Pane>
          </Pane.Split>
        )}
      </Pane>
    </Workspace>
  );
}

// The states that Fibel's Example offers beside the default; the recipe test renders each one as well.
export const states = {
  grid: () => <Folder grid />,
  selecting: () => <Folder grid selected={["front", "vorher", "granit"]} />,
};
