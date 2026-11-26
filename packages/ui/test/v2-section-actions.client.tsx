import { render } from "solid-js/web";
import { Pane, Section, Tabs, Text, Workspace } from "../src/v2";

// A record's section with two deeds in its head (W2): one with a symbol, one with words only. On the phone the one
// with a symbol keeps only its symbol; both keep their names for assistive technology.

declare global {
  interface Window {
    __k2Mounted?: boolean;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("section actions: #root is missing");
// `<body data-case="status-tabs">`: an open user in Core's admin (S2), its areas as tabs in the detail's status slot
if (document.body.dataset.case === "status-tabs")
  render(
    () => (
      <Workspace>
        <Pane.Split>
          <Pane label="Personen">
            <Text>Ada Renz</Text>
          </Pane>
          <Pane
            label="Ada Renz"
            detail
            status={
              <Tabs
                label="Bereiche"
                items={[
                  { label: "Konto", current: true, onClick: () => undefined },
                  { label: "Gruppen", onClick: () => undefined },
                  { label: "Sitzungen", onClick: () => undefined },
                ]}
              />
            }
          >
            <Text>Angemeldet seit 12. Nov.</Text>
          </Pane>
        </Pane.Split>
      </Workspace>
    ),
    root,
  );
else
  render(
    () => (
      <Workspace>
        <Pane label="Akte">
          <Section
            title="Vorgänge"
            count={3}
            actions={[
              { label: "Neuer Vorgang", icon: "plus", onClick: () => undefined },
              { label: "Alle ansehen", onClick: () => undefined },
            ]}
          >
            <Text>Drei Vorgänge sind offen.</Text>
          </Section>
        </Pane>
      </Workspace>
    ),
    root,
  );
window.__k2Mounted = true;
