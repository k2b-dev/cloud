import { orderQuery } from "../skills/k2b-ui/recipes/filtered-table";
import { Bar, Button, FilterBar, Input, List, Nav, Pane, Path, Row, Tabs, Text, Workspace } from "../src/v2";

declare global {
  interface Window {
    /** How often each main action ran, by its name. */
    __created?: Record<string, number>;
  }
}

const ran = (name: string) => () => {
  window.__created = { ...window.__created, [name]: (window.__created?.[name] ?? 0) + 1 };
};

const state = orderQuery.parse("status=open,work").state;

/**
 * A head whose toolbar stands in it (Files, Notebooks): the folder's name, its filter bar, the search and the main
 * action. It stands in the head line while the head has room, and wraps as the head's second row below that.
 */
export function ToolbarInHead() {
  return (
    <Workspace
      head={
        <Bar
          start={
            <>
              <Text weight="strong">Verträge</Text>
              <FilterBar query={orderQuery} state={state} onChange={() => {}} results="3 Aufträge" />
            </>
          }
          end={
            <>
              <Input type="search" icon="search" label="Aufträge durchsuchen" placeholder="Aufträge durchsuchen" />
              <Button variant="primary" icon="plus">
                Auftrag
              </Button>
            </>
          }
        />
      }
    >
      <Pane label="Aufträge">
        <List label="Aufträge">
          <Row icon="file-text" lines={["Einbauschrank Flur"]} />
        </List>
      </Pane>
    </Workspace>
  );
}

/** A head with two main actions (Files: upload and a new folder): the platform makes them one "+". */
export function TwoCreates() {
  return (
    <Workspace
      head={
        <Bar
          start={<Text weight="strong">Ablage</Text>}
          end={
            <>
              <Input type="search" icon="search" label="Dateien durchsuchen" placeholder="Dateien durchsuchen" />
              <Button variant="primary" icon="upload" onClick={ran("Hochladen")}>
                Hochladen
              </Button>
              <Button variant="primary" icon="folder-plus" onClick={ran("Neuer Ordner")}>
                Neuer Ordner
              </Button>
            </>
          }
        />
      }
      primary={{ label: "Hochladen", icon: "upload" }}
    >
      <Pane label="Dateien">
        <List label="Dateien">
          <Row icon="file" lines={["Angebot.pdf"]} />
        </List>
      </Pane>
    </Workspace>
  );
}

/**
 * A page the sidebar's current entry names ("Einstellungen"): the head repeats it as its title, beside an action.
 * `detail` declares a wide detail, so the sidebar is a drawer from 1024 px of window on.
 */
export function NamedPlace(props: { detail?: number }) {
  return (
    <Workspace
      detail={props.detail}
      sidebar={
        <Nav
          title="Ablage"
          icon="folder"
          groups={[
            {
              items: [
                { label: "Alle Ablagen", icon: "folders", href: "#alle" },
                { label: "Einstellungen", icon: "settings", href: "#einstellungen", current: true },
              ],
            },
          ]}
        />
      }
      head={<Bar start={<Text weight="strong">Einstellungen</Text>} end={<Button icon="device-floppy">Speichern</Button>} />}
    >
      <Pane label="Einstellungen">
        <List label="Einstellungen">
          <Row icon="bell" lines={["Benachrichtigungen"]} />
        </List>
      </Pane>
    </Workspace>
  );
}

/** A list whose address holds a search (`?q=Zeppelin`): the server renders the head's search with its words. */
export function SearchWithWords() {
  return (
    <Workspace
      head={
        <Bar
          start={
            <Tabs
              label="Ansichten"
              items={[
                { label: "Alle", current: true, href: "?q=Zeppelin" },
                { label: "Meine", href: "?view=mine&q=Zeppelin" },
              ]}
            />
          }
          end={<Input type="search" icon="search" label="Notizbücher durchsuchen" value="Zeppelin" />}
        />
      }
    >
      <Pane label="Notizbücher">
        <List label="Notizbücher">
          <Row icon="notebook" lines={["Kein Notizbuch passt zu „Zeppelin“"]} />
        </List>
      </Pane>
    </Workspace>
  );
}

/** A photo of a long name, opened in its folder (U3): its path gives way before the head's actions. */
export const longPhoto = "IMG_2026_11_26_Kaffeehaus_am_Marktplatz_im_Morgenlicht_mit_Blick_auf_den_Brunnen_Espresso.jpg";

/** The head of an open photo: the path to it (its folder is the page itself, `#fotos`) and two actions. */
export function LongPath() {
  return (
    <Workspace
      head={
        <Bar
          start={
            <Path
              label="Ort"
              items={[{ label: "Ablage", href: "#ablage" }, { label: "Fotos 2026", href: "#fotos" }, { label: longPhoto }]}
            />
          }
          end={
            <>
              <Button icon="share">Teilen</Button>
              <Button icon="download">Herunterladen</Button>
            </>
          }
        />
      }
    >
      <Pane label="Foto">
        <List label="Angaben">
          <Row icon="photo" lines={[longPhoto]} />
        </List>
      </Pane>
    </Workspace>
  );
}
