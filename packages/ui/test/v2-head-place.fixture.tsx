import { LocaleProvider } from "../src/intl/locale";
import { Bar, Button, HeadSearch, List, Nav, Pane, Path, Row, Text, Workspace } from "../src/v2";

// What a workspace's head knows of its place, as the test sets it up:
// - `creates`: a head with two main actions ("Hochladen", "Neuer Ordner") and a ghost one ("Teilen"): the two stand as
//   one "+ Neu" menu at the head's end, and the phone's round button offers them both;
// - `repeats`: the sidebar's current entry is "Einstellungen", and the head's title says the same beside an action:
//   the title gives way while the sidebar shows; `repeatsOnly`: the head holds that title alone and gives way whole;
// - `hollow`: a head without a start whose end holds only the main action the round button repeats (`floats`): on the
//   phone it takes no room; `hollowSearch`: the same with a head search, which keeps the head without a host;
// - `detail`: a list beside an open entry whose head names it after a path (small, in the path's row), with its way
//   back: on the phone the way back stands in the head's row;
// - `path`: a head whose path ends in a long file name: cut in its middle where it has no room, its end kept.
export type Kind = "creates" | "repeats" | "repeatsOnly" | "hollow" | "hollowSearch" | "detail" | "path";

declare global {
  interface Window {
    /** The deed a main action of `creates` ran last. */
    __k2Created?: string;
  }
}

const created = (deed: string) => () => {
  window.__k2Created = deed;
};

const Sidebar = () => (
  <Nav
    title="Dateien"
    icon="folder"
    groups={[
      {
        items: [
          { label: "Alle Ablagen", icon: "folders", href: "#ablagen" },
          { label: "Einstellungen", icon: "settings", href: "#einstellungen", current: true },
        ],
      },
    ]}
  />
);

const Rows = () => (
  <List>
    <Row lines={["Angebote", "12 Dateien"]} />
    <Row lines={["Fotos", "48 Dateien"]} />
  </List>
);

const longName = "IMG_20260412_101500_Werkstatt_Espresso.jpg";

const Head = (props: { kind: Kind }) => {
  switch (props.kind) {
    case "creates":
      return (
        <Bar
          start={<Text>Ablagen</Text>}
          end={
            <>
              <Button variant="ghost" icon="share">
                Teilen
              </Button>
              <Button variant="primary" icon="upload" onClick={created("upload")}>
                Hochladen
              </Button>
              <Button variant="primary" icon="folder-plus" onClick={created("folder")}>
                Neuer Ordner
              </Button>
            </>
          }
        />
      );
    case "repeats":
      return (
        <Bar
          start={<Text>Einstellungen</Text>}
          end={
            <Button variant="ghost" icon="download">
              Exportieren
            </Button>
          }
        />
      );
    case "repeatsOnly":
      return <Bar start={<Text>Einstellungen</Text>} />;
    case "hollow":
      return (
        <Bar
          end={
            <Button variant="primary" icon="plus" floats>
              Neue Basis
            </Button>
          }
        />
      );
    case "hollowSearch":
      return (
        <Bar
          end={
            <>
              <HeadSearch label="Basen suchen" />
              <Button variant="primary" icon="plus" floats>
                Neue Basis
              </Button>
            </>
          }
        />
      );
    case "path":
      return (
        <Bar
          start={
            <Path label="Ort" items={[{ label: "Ablagen", href: "#ablagen" }, { label: "Fotos", href: "#fotos" }, { label: longName }]} />
          }
          end={
            <>
              <Button variant="ghost" icon="share">
                Teilen
              </Button>
              <Button variant="ghost" icon="download">
                Herunterladen
              </Button>
            </>
          }
        />
      );
    default:
      return undefined;
  }
};

export const Fixture = (props: { kind: Kind }) => (
  <LocaleProvider locale="de">
    <Workspace
      sidebar={<Sidebar />}
      head={<Head kind={props.kind} />}
      primary={{ label: "Neu", icon: "plus" }}
      detail={props.kind === "detail" ? true : undefined}
    >
      {props.kind === "detail" ? (
        <Pane.Split>
          <Pane label="Dateien" width={{ min: 280, default: 320 }}>
            <Rows />
          </Pane>
          <Pane
            label={longName}
            detail
            back={{ label: "Fotos", onClick: () => {} }}
            head={
              <Bar
                start={
                  <>
                    <Path
                      label="Ort der Datei"
                      items={[
                        { label: "Ablagen", href: "#ablagen" },
                        { label: "Fotos", href: "#fotos" },
                      ]}
                    />
                    <Text>Espresso.jpg</Text>
                  </>
                }
                end={<Button variant="ghost" icon="x" label="Schließen" closes />}
              />
            }
          >
            <Text>Aufgenommen am 12. April 2026 in der Werkstatt.</Text>
          </Pane>
        </Pane.Split>
      ) : (
        <Pane label="Ablagen">
          <Rows />
        </Pane>
      )}
    </Workspace>
  </LocaleProvider>
);
