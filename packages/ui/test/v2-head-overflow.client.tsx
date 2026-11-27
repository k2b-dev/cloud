import { render } from "solid-js/web";
import { Avatar, Bar, Button, Chip, Icon, Inline, Menu, Pane, Table, Text, Workspace } from "../src/v2";

// The worst case of a head and of a name in a table (break-ui of Mail's admin, 26.11.): a head whose start is a long
// subject beside its actions (buttons and a "…" menu), the same in a pane's head, and a table whose name cells set a
// symbol or an avatar, a long name and a chip in one `Inline`. The actions and the marks keep their size; the
// subject and the names give way with "…".

declare global {
  interface Window {
    __k2Mounted?: boolean;
  }
}

const subject =
  "Rückfrage zur Rechnung RE-2026-11-004711 der Donaudampfschifffahrtselektrizitätenhauptbetriebswerkbauunterbeamtengesellschaft – Antwort auf Ihre Nachricht vom 26. November 2026 wegen der offenen Posten aus dem dritten Quartal";

type Entry = { id: string; name: string; mail: string; managed: boolean; state: "ok" | "warn" | "bad" };
const entries: Entry[] = [
  { id: "1", name: "Maximiliane Theodora von Hohenzollern-Sigmaringen-Wittelsbach", mail: "max@example.org", managed: true, state: "ok" },
  {
    id: "2",
    name: "ein.sehr.langer.unbrechbarer.name.ohne.leerzeichen@verwaltung.beispielunternehmen.example",
    mail: "lang@example.org",
    managed: true,
    state: "warn",
  },
  { id: "3", name: "Ö", mail: "o@example.org", managed: false, state: "bad" },
  {
    id: "4",
    name: "🎉🎉🎉 Festkomitee Sommerfest 2026 – Organisation und Planung 🎉🎉🎉",
    mail: "fest@example.org",
    managed: true,
    state: "ok",
  },
];

const actions = () => (
  <>
    <Button icon="check" label="Erledigt" />
    <Button icon="arrow-back-up" label="Antworten" />
    <Menu
      items={[
        { label: "Weiterleiten", icon: "arrow-forward-up" },
        { label: "Löschen", icon: "trash", danger: true },
      ]}
    />
  </>
);

const root = document.getElementById("root");
if (!root) throw new Error("head-overflow: #root is missing");
render(
  () => (
    <Workspace head={<Bar start={<Text type="lead">{subject}</Text>} end={actions()} />}>
      <Pane label="Postfächer" head={<Bar start={<Text type="lead">{subject}</Text>} end={actions()} />}>
        <Table
          label="Postfächer"
          rows={entries}
          rowKey={(entry) => entry.id}
          // the rows open their entry, so the first cell holds the row's link around its line (Mail's admin)
          open={(entry) => ({ href: `#open=${entry.id}` })}
          phone={(entry) => ({ lines: [entry.name, entry.mail] })}
          columns={[
            {
              title: "Name",
              width: { min: 160, default: 280 },
              cell: (entry) => (
                <Inline>
                  <Avatar name={entry.name} decorative />
                  <Text weight="strong">{entry.name}</Text>
                  {entry.managed ? <Chip>Verwaltet</Chip> : undefined}
                </Inline>
              ),
            },
            {
              title: "Zustand",
              width: { min: 160, default: 240 },
              cell: (entry) => (
                <Inline>
                  <Icon name="mail" />
                  <Text>{entry.name}</Text>
                  <Chip status={entry.state}>{entry.state === "ok" ? "In Ordnung" : entry.state === "warn" ? "Wartet" : "Fehler"}</Chip>
                </Inline>
              ),
            },
            { title: "Adresse", width: { min: 140, default: 220 }, cell: (entry) => entry.mail, drop: true },
          ]}
        />
      </Pane>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
