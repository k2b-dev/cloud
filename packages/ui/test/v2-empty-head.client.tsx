import { render } from "solid-js/web";
import { Band, Bar, Input, Menu, Nav, Pane, Row, Section, Tabs, Text, Workspace } from "../src/v2";

// A workspace head with only actions at its end (Mail's administration: a search and "…"), above
// - `hero`: one pane without a head of its own, a hero band first and a section last (Postfächer);
// - `tabs`: a list with tabs as its head beside its reader (Sicherheit);
// - `none`: content that is no pane, which takes nothing.
// `window.__k2Case` picks one.

declare global {
  interface Window {
    __k2Mounted?: boolean;
    __k2Case?: "hero" | "tabs" | "none";
  }
}

const actions = () => (
  <>
    <Input type="search" icon="search" label="Postfächer durchsuchen" placeholder="Postfächer nach Name" />
    <Menu label="Weitere Aktionen" items={[{ label: "Speicher neu zählen", icon: "refresh" }]} />
  </>
);

const sidebar = () => (
  <Nav
    title="Verwaltung"
    icon="settings"
    groups={[
      {
        items: [
          { label: "Postfächer", icon: "inbox", href: "#postfaecher", current: true },
          { label: "Sicherheit", icon: "shield", href: "#sicherheit" },
        ],
      },
    ]}
  />
);

const hero = () => (
  <Pane label="Postfächer">
    <Band label="Überblick">
      <Text type="lead">2 Postfächer ohne Verwaltung</Text>
      <Text type="meta" muted>
        Personal, Lager Nord · 12 von 12 Postfächern · 38,6 GB · aktualisiert vor 12 Min.
      </Text>
    </Band>
    <Row icon="inbox" lines={["Verwaltung", "Aktiv · vor 2 Min."]} />
    <Row icon="inbox" lines={["Kundendienst", "Aktiv · vor 1 Min."]} />
    <Section title="Kontaktverzeichnis" icon="address-book">
      <Row icon="address-book" lines={["Kontakte", "Standard"]} />
    </Section>
  </Pane>
);

const tabs = () => (
  <Pane.Split>
    <Pane
      label="Meldungen"
      width={{ min: 400, default: 640 }}
      head={
        <Tabs
          label="Bereiche"
          items={[
            { label: "Meldungen", count: 5, current: true, href: "#meldungen" },
            { label: "Regeln", count: 4, href: "#regeln" },
          ]}
        />
      }
    >
      <Row icon="flag" lines={["rechnung@example.com", "Neu"]} />
      <Row icon="flag" lines={["ceo@example.com", "In Prüfung"]} />
    </Pane>
    <Pane label="Meldung">
      <Row icon="flag" lines={["Nichts geöffnet"]} />
    </Pane>
  </Pane.Split>
);

const root = document.getElementById("root");
if (!root) throw new Error("empty head: #root is missing");
const which = window.__k2Case ?? "hero";
render(
  () => (
    <Workspace sidebar={sidebar()} head={<Bar end={actions()} />}>
      {which === "hero" ? hero() : which === "tabs" ? tabs() : <Text>Kein Fenster</Text>}
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
