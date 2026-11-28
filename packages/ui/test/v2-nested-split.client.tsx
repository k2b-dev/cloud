import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import { Bar, Button, Dialog, Nav, Pane, Section, StatusRow, Text, Workspace } from "../src/v2";

// A split inside a column, as Files and the pairing screen build it, in a window like Cloud's shell (66 px beside the
// workspace). `window.__k2Case` chooses before this bundle runs:
// - "files": a column with a status row whose content is a list (flexible, keeps 400 px) beside a detail of 320 to
//   380 px. The workspace declares the detail (`detail={320}`), so its room counts open or closed;
//   `window.__k2Detail(false)` closes it.
// - "inner": the same column, whose split holds a list of 320 to 360 px beside a main column (no detail): the column
//   asks the workspace for 320 + 1 + 400 px.
// - "dialog": a column of 400 px with a dialog open over it, whose content is a split of 400 + 320 px: the dialog asks
//   the workspace behind it for no room.
// - "record": a detail (`Pane detail`) whose content is a main column and an info column (`Pane side`, 280 to 320 px)
//   beside a list of 360 px, as #4340's record on a large screen.

declare global {
  interface Window {
    __k2Mounted?: boolean;
    __k2Case?: "files" | "inner" | "dialog" | "record";
    __k2Detail?: (open: boolean) => void;
  }
}

const nav = (
  <Nav
    title="Dateien"
    icon="folders"
    groups={[
      {
        items: [
          { label: "Zuletzt", icon: "clock" },
          { label: "Küche Lindqvist", icon: "folder", current: true },
        ],
      },
    ]}
  />
);

const Files = () => {
  const [open, setOpen] = createSignal(true);
  window.__k2Detail = setOpen;
  return (
    <Workspace
      sidebar={nav}
      sidebarLabel="Breite der Seitenleiste"
      detail={320}
      head={<Bar start={<Text type="lead">Küche Lindqvist</Text>} />}
    >
      <Pane label="Küche Lindqvist" status={<StatusRow lead="12 Dateien" />}>
        <Pane.Split>
          <Pane label="Dateien">
            <Text>Front Eiche.jpg</Text>
          </Pane>
          <Show when={open()}>
            <Pane detail label="Ansicht" width={{ min: 320, default: 380 }}>
              <Section title="Front Eiche.jpg">
                <Text>Ein Foto der Front.</Text>
              </Section>
            </Pane>
          </Show>
        </Pane.Split>
      </Pane>
    </Workspace>
  );
};

const Inner = () => (
  <Workspace sidebar={nav} sidebarLabel="Breite der Seitenleiste" head={<Bar start={<Text type="lead">Küche Lindqvist</Text>} />}>
    <Pane label="Küche Lindqvist" status={<StatusRow lead="12 Dateien" />}>
      <Pane.Split>
        <Pane label="Ordner" width={{ min: 320, default: 360 }}>
          <Text>Fotos</Text>
        </Pane>
        <Pane label="Dateien">
          <Text>Front Eiche.jpg</Text>
        </Pane>
      </Pane.Split>
    </Pane>
  </Workspace>
);

const InDialog = () => (
  <Workspace sidebar={nav} sidebarLabel="Breite der Seitenleiste" head={<Bar start={<Text type="lead">Küche Lindqvist</Text>} />}>
    <Pane label="Küche Lindqvist">
      <Text>Front Eiche.jpg</Text>
      <Dialog title="Neue Ablage" open onOpenChange={() => {}} foot={<Button variant="primary">Anlegen</Button>}>
        <Pane.Split>
          <Pane label="Vorlage">
            <Text>Leer</Text>
          </Pane>
          <Pane label="Vorschau" width={{ min: 320, default: 360 }}>
            <Text>Keine Dateien</Text>
          </Pane>
        </Pane.Split>
      </Dialog>
    </Pane>
  </Workspace>
);

const Record = () => (
  <Workspace sidebar={nav} sidebarLabel="Breite der Seitenleiste">
    <Pane.Split>
      <Pane label="Liste" width={{ min: 280, default: 360 }}>
        <Text>Quellen</Text>
      </Pane>
      <Pane detail label="Quelle 1" head={<Bar start={<Text type="lead">Quelle 1</Text>} />}>
        <Pane.Split>
          <Pane label="Was sie ist">
            <Section title="Verbindung">
              <Text>Abruf alle 5 Minuten</Text>
            </Section>
          </Pane>
          <Pane side label="Kontext" width={{ min: 280, default: 320 }}>
            <Section title="Zuletzt">
              <Text>Quelle 1 angelegt</Text>
            </Section>
          </Pane>
        </Pane.Split>
      </Pane>
    </Pane.Split>
  </Workspace>
);

const cases = { files: Files, inner: Inner, dialog: InDialog, record: Record };
const root = document.getElementById("root");
if (!root) throw new Error("nested split: #root is missing");
const Chosen = cases[window.__k2Case ?? "files"];
render(() => <Chosen />, root);
window.__k2Mounted = true;
