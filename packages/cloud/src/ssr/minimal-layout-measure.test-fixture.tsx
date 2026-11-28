import { Bar, Button, Facts, List, Pane, RecordHead, Row, Section, Text, Workspace } from "@k2b/ui/v2";

// An invented visitor page for `MinimalLayout measure` (MinimalLayout.measure.browser.test.ts): `page`, a place's
// programme with a side column; `task`, its one task (a short message to the place).

const place = { name: "Nachbarschaftshaus Am Wehr", initials: "NW", color: "#0f766e" };

export function PageFixture() {
  return (
    <Workspace
      head={
        <Bar
          start={<RecordHead name={place.name} avatar={place} />}
          end={
            <Button variant="primary" href="#nachricht" keep>
              Nachricht
            </Button>
          }
        />
      }
    >
      <Pane.Split>
        <Pane label="Heute">
          <Section icon="calendar" color={place.color} title="Heute">
            <List>
              <Row lines={["Repair-Café", "14:00–17:00 · Werkstatt"]} />
              <Row lines={["Chor am Wehr", "18:30–20:00 · Saal"]} />
              <Row lines={["Spieleabend", "20:00–22:00 · Café"]} />
            </List>
          </Section>
          <Section icon="info-circle" color={place.color} title="Über uns">
            <Text>Ein offenes Haus für alle im Viertel, getragen von einem Verein und vielen Ehrenamtlichen.</Text>
          </Section>
        </Pane>
        <Pane side label="Öffnungszeiten" width={{ fixed: 360 }}>
          <Section icon="clock" color={place.color} title="Öffnungszeiten">
            <Facts
              items={[
                { label: "Montag bis Freitag", value: "10:00–22:00" },
                { label: "Samstag", value: "12:00–18:00" },
                { label: "Sonntag", value: "geschlossen" },
              ]}
            />
          </Section>
        </Pane>
      </Pane.Split>
    </Workspace>
  );
}

export function TaskFixture() {
  return (
    <Workspace head={<Bar start={<RecordHead name={place.name} avatar={place} />} />}>
      <Pane label="Nachricht">
        <Section title="Schreib uns">
          <Text>Wir antworten meist innerhalb von zwei Tagen.</Text>
        </Section>
        <Bar end={<Button variant="primary">Senden</Button>} />
      </Pane>
    </Workspace>
  );
}
