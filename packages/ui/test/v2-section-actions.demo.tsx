import { List, Pane, Row, Section, Workspace } from "../src/v2";

// Section heads with text buttons in a narrow detail beside a list (Files, DP: "Verwalten" was cut at 800 px): a title
// that leaves no room for two buttons, one that leaves room for one, and a title so long that it alone fills the head.
// Each deed lands in `window.__sectionDeeds`. The names are invented.

declare global {
  interface Window {
    __sectionDeeds?: string[];
  }
}

const did = (deed: string) => () => {
  window.__sectionDeeds = [...(window.__sectionDeeds ?? []), deed];
};

export function Demo() {
  return (
    <Workspace>
      <Pane.Split>
        <Pane label="Ordner" width={{ min: 320, default: 420 }}>
          <List label="Ordner">
            <Row icon="folder" lines={["Angebote 2026"]} current />
            <Row icon="folder" lines={["Rechnungen"]} />
          </List>
        </Pane>
        <Pane detail label="Ordner Angebote 2026">
          <Section
            icon="users"
            title="Freigaben für Mitarbeitende"
            count={4}
            actions={[
              { label: "Hinzufügen", icon: "plus", onClick: did("add") },
              { label: "Verwalten", icon: "settings", href: "#verwalten" },
            ]}
          >
            <Row icon="user" lines={["Anna Berger"]} />
          </Section>
          <Section icon="history" title="Verlauf" actions={[{ label: "Verwalten", icon: "settings", onClick: did("history") }]}>
            <Row icon="file" lines={["Angebot Küche Oswald"]} />
          </Section>
          <Section
            icon="archive"
            title="Aufbewahrung nach Handelsrecht und Abgabenordnung für alle Belege dieses Ordners"
            actions={[{ label: "Verwalten", icon: "settings", onClick: did("keep") }]}
          >
            <Row icon="file" lines={["Zehn Jahre"]} />
          </Section>
        </Pane>
      </Pane.Split>
    </Workspace>
  );
}
