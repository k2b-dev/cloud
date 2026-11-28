import { render } from "solid-js/web";
import { Band, Bar, Button, Inline, Pane, RangeBar, RecordHead, Row, Section, Table, Text, Workspace } from "../src/v2";

// A page with an accent of its own, as a visitor page of a place shows it: its colour (`window.__k2Accent`, set by the
// test before the script) on the one primary action, on the state in the hero (a band in its tint, as without a
// picture above it), and on a week of opening hours, today's bar the strongest. An invented place; the test reads the
// colours and their contrast, light and dark.

declare global {
  interface Window {
    __k2Mounted?: boolean;
    __k2Accent?: string;
  }
}

const week = [
  { day: "Montag", from: 8, to: 18, words: "08:00–18:00" },
  { day: "Dienstag", from: 8, to: 18, words: "08:00–18:00" },
  { day: "Mittwoch", from: 8, to: 18, words: "08:00–18:00" },
  { day: "Donnerstag", from: 8, to: 18, words: "08:00–18:00" },
  { day: "Freitag", from: 8, to: 16, words: "08:00–16:00" },
  { day: "Samstag", from: 10, to: 15, words: "10:00–15:00" },
  { day: "Sonntag", from: Number.NaN, to: Number.NaN, words: "Geschlossen" },
];
const menu = [
  { name: "Linsensuppe mit Brot", note: "vegan", price: "3,90 €" },
  { name: "Ofengemüse mit Kräuterdip", note: "vegetarisch", price: "4,50 €" },
  { name: "Apfelkuchen", note: "vegetarisch", price: "2,20 €" },
];

const root = document.getElementById("root");
if (!root) throw new Error("accent: #root is missing");
render(
  () => (
    <Workspace
      accent={window.__k2Accent}
      head={
        <Bar
          start={<RecordHead name="Lindencafé am Markt" avatar={{ name: "Lindencafé am Markt", color: window.__k2Accent }} />}
          end={
            <Button variant="primary" href="#bewerten">
              Bewerten
            </Button>
          }
        />
      }
    >
      <Pane label="Lindencafé am Markt">
        <Pane.Split>
          <Pane label="Heute">
            <Band tone="app">
              <Inline>
                <Text type="lead" weight="strong" tone="app">
                  Geöffnet
                </Text>
                <Text type="lead">bis 15:00</Text>
              </Inline>
              <Text muted>Morgen geschlossen · Montag ab 08:00</Text>
            </Band>
            <Section icon="tools-kitchen-2" color={window.__k2Accent} title="Heute auf der Karte" count={menu.length}>
              {menu.map((dish) => (
                <Row lines={[dish.name, dish.note]} end={<Text>{dish.price}</Text>} />
              ))}
            </Section>
          </Pane>
          <Pane side label="Öffnungszeiten" width={{ fixed: 360 }}>
            <Section icon="clock" color={window.__k2Accent} title="Öffnungszeiten">
              <Table
                label="Öffnungszeiten"
                rows={week}
                rowKey={(row) => row.day}
                current="Samstag"
                columns={[
                  { title: "Tag", width: { fixed: 112 }, cell: (row) => row.day },
                  { title: "6–24 Uhr", cell: (row) => <RangeBar from={row.from} to={row.to} domain={[6, 24]} decorative /> },
                  { title: "Zeiten", width: { fixed: 112 }, align: "end", cell: (row) => row.words },
                ]}
              />
            </Section>
          </Pane>
        </Pane.Split>
      </Pane>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
