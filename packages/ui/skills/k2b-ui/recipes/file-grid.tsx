// Recipe: files as picture tiles, dragged onto folders. The open folder's files stand as tiles in the size the
// person chose (in the address); a tile or several selected ones drag onto a folder of the grid or the sidebar's tree.
// Dragging is a shortcut: every tile's menu says "Verschieben nach …", for keys and touch.
import { Bar, type DragMove, Menu, Nav, type NavTreeNode, Pane, Path, StatusRow, Tiles, Workspace } from "@k2b/ui/v2";

type File = { id: string; name: string; size: string; kind: "folder" | "photo" | "pdf"; thumb?: string };

// sample pictures, drawn in place; an app gives the address of its thumbnail, such as `/files/<id>/thumb`
const swatch = (from: string, to: string) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><linearGradient id="g" x2="1" y2="1"><stop stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient><rect width="400" height="300" fill="url(#g)"/></svg>`,
  )}`;

const files: File[] = [
  { id: "belege", name: "Belege", size: "12 Dateien", kind: "folder" },
  { id: "messe", name: "Messestand.jpg", size: "3,2 MB", kind: "photo", thumb: swatch("#9cc3e6", "#3d6fa8") },
  { id: "werkstatt", name: "Werkstatt Eichentisch.jpg", size: "4,1 MB", kind: "photo", thumb: swatch("#e8c9a0", "#a0673a") },
  { id: "lieferung", name: "Lieferung Holzhandel Berger.jpg", size: "2,7 MB", kind: "photo", thumb: swatch("#b9dcb4", "#4f8a4a") },
  { id: "angebot", name: "Angebot Lackfabrik Nordhaus.pdf", size: "220 KB", kind: "pdf" },
];
const icon = { folder: "folder", photo: "photo", pdf: "file-type-pdf" } as const;

const folders: NavTreeNode[] = [
  {
    key: "projekte",
    label: "Projekte",
    icon: "folder",
    href: "/files/projekte",
    children: [{ key: "website", label: "Website", icon: "folder", href: "/files/website", branch: true }],
  },
  { key: "archiv", label: "Archiv", icon: "archive", href: "/files/archiv", branch: true },
];

type Props = { size?: "s" | "m" | "l"; selected?: readonly string[] };

export default function FileGrid(props: Props) {
  const size = () => props.size ?? "m";
  // one drag for the tiles and the tree: a file or folder goes into a folder; the server moves it on the drop
  const drag: DragMove = {
    scope: "files",
    label: (key) => files.find((file) => file.id === key)?.name ?? key,
    target: (key) => key === "belege" || key === "projekte" || key === "website" || key === "archiv",
    onDrop: () => {},
    onFiles: () => {},
  };
  return (
    <Workspace
      sidebar={
        <Nav
          title="Dateien"
          icon="folder"
          groups={[{ label: "Ordner", tree: { label: "Ordner", items: folders, current: "projekte", drag } }]}
        />
      }
      head={
        <Bar
          start={<Path label="Ort" items={[{ label: "Projekte" }]} />}
          end={
            <Menu
              icon="layout-grid"
              items={[
                {
                  title: "Größe",
                  choice: size(),
                  items: [
                    { label: "Klein", value: "s", href: "?size=s" },
                    { label: "Mittel", value: "m", href: "?size=m" },
                    { label: "Groß", value: "l", href: "?size=l" },
                  ],
                },
              ]}
            >
              Ansicht
            </Menu>
          }
        />
      }
    >
      <Pane
        label="Projekte"
        status={
          <StatusRow
            lead={`${files.length} Einträge`}
            selection={
              props.selected?.length
                ? {
                    count: `${props.selected.length} ausgewählt`,
                    actions: [{ label: "Verschieben nach …", icon: "folder-symlink" }],
                    clear: { label: "Auswahl aufheben", icon: "x" },
                  }
                : undefined
            }
          />
        }
      >
        <Tiles
          label="Dateien in Projekte"
          size={size()}
          items={files.map((file) => ({
            key: file.id,
            icon: icon[file.kind],
            title: file.name,
            meta: file.size,
            image: file.thumb,
            href: `/files/${file.id}`,
          }))}
          select={{ selected: props.selected ?? [], onChange: () => {} }}
          drag={drag}
        />
      </Pane>
    </Workspace>
  );
}

export const states = {
  small: () => <FileGrid size="s" />,
  large: () => <FileGrid size="l" />,
  selected: () => <FileGrid selected={["messe", "werkstatt"]} />,
};
