import { render } from "solid-js/web";
import { Bar, Nav, Pane, Section, StatusRow, Text, Workspace } from "../src/v2";

// A split inside a column, as Files and the pairing screen build it, in a window like Cloud's shell (66 px beside the
// workspace). `window.__k2Case` chooses before this bundle runs:
// - "files": a column with a status row whose content is a list (flexible, keeps 400 px) beside an open detail of 320
//   to 380 px. The workspace counts what the split inside needs: 400 + 1 + 320 px beside its sidebar.
// - "record": a detail (`Pane detail`) whose content is a main column and an info column (`Pane side`, 280 to 320 px)
//   beside a list of 360 px, as #4340's record on a large screen.

declare global {
  interface Window {
    __k2Mounted?: boolean;
    __k2Case?: "files" | "record";
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

const Files = () => (
  <Workspace sidebar={nav} sidebarLabel="Breite der Seitenleiste" head={<Bar start={<Text type="lead">Küche Lindqvist</Text>} />}>
    <Pane label="Küche Lindqvist" status={<StatusRow lead="12 Dateien" />}>
      <Pane.Split>
        <Pane label="Dateien">
          <Text>Front Eiche.jpg</Text>
        </Pane>
        <Pane detail label="Ansicht" width={{ min: 320, default: 380 }}>
          <Section title="Front Eiche.jpg">
            <Text>Ein Foto der Front.</Text>
          </Section>
        </Pane>
      </Pane.Split>
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

const root = document.getElementById("root");
if (!root) throw new Error("nested split: #root is missing");
render(() => (window.__k2Case === "record" ? <Record /> : <Files />), root);
window.__k2Mounted = true;
