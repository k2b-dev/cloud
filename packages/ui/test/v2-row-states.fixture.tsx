import { Bar, Canvas, Cells, Chip, List, Pane, Row, Section, StatusRow, Text, Workspace } from "../src/v2";

// Rows whose states must be read whole (the domain checks of the administration, S2 #4174), in their worst case: many
// states, a state longer than the row, rows with and without states side by side. Beside it a drawing that is the
// whole pane (an editor, a frame of another page), which takes the pane's height by layout alone.

const domain = { icon: "world", color: "#0284c7" };

export const RowStatesScreen = () => (
  <Workspace>
    <Pane label="Domains" status={<StatusRow lead="4 Domains" facts={[{ value: 2, after: "mit Lücken" }]} />}>
      <Section title="Domains" count={4}>
        <List label="Domains">
          <Row mark={domain} lines={["kolb-antik.de"]} time="geprüft 09:40" />
          <Row
            mark={domain}
            lines={["mail.kolb-antik.de"]}
            time="geprüft 09:40"
            states={
              <>
                <Chip status="ok">SPF gültig</Chip>
                <Chip status="warn">DKIM fehlt für selector2</Chip>
                <Chip status="bad">DMARC p=none</Chip>
                <Chip status="ok">MX erreichbar</Chip>
                <Chip status="ok">TLS 1.3</Chip>
                <Chip status="warn">Rückwärtsauflösung fehlt</Chip>
              </>
            }
          />
          <Row
            mark={domain}
            lines={["werkstatt.kolb-antik-handwerk-und-restaurierung.example", "Weiterleitung auf kolb-antik.de"]}
            states={
              <>
                <Chip status="bad">Zertifikat läuft in 3 Tagen ab: werkstatt.kolb-antik-handwerk-und-restaurierung.example, erneuern</Chip>
                <Chip status="ok">SPF gültig</Chip>
              </>
            }
          />
          <Row mark={domain} lines={["alt.kolb-antik.de", "stillgelegt seit 01.10.2026"]} />
        </List>
      </Section>
    </Pane>
  </Workspace>
);

// Key numbers in their worst case (lane C, gateway-ops #4205): long labels, big numbers, an amount chip, a trend, and
// four cells beside three.
export const CellsScreen = () => (
  <Workspace>
    <Pane label="Übersicht">
      <Cells>
        <Cells.Cell
          icon="login-2"
          label="Anmeldungen in den letzten 24 Stunden über alle Anmeldeverfahren"
          value="12.345.678"
          meta="6 % mehr als am vergangenen Mittwoch zur gleichen Zeit"
          trend={{ values: [14, 10, 24, 58, 70, 52, 44], label: "Anmeldungen je Stunde" }}
        />
        <Cells.Cell icon="route" label="Anfragen je Sekunde" value="1.234.567" meta="Spitze 09:41" />
        <Cells.Cell
          icon="currency-euro"
          label="Umsatz heute"
          value={<Chip amount="in">123.456,78 €</Chip>}
          meta="davon offen 12.345,00 €"
        />
        <Cells.Cell
          icon="alert-triangle"
          label="Fehler"
          value={<Chip status="bad">17 kritisch</Chip>}
          meta="davon 3 neu seit 09:00"
          href="#fehler"
        />
      </Cells>
      <Cells>
        <Cells.Cell icon="database" label="Speicher" value="38,2 von 100 GB" meta="Werkstatt" />
        <Cells.Cell icon="users" label="Konten" value="192" meta="23 Gäste" />
        <Cells.Cell icon="clock" label="Letzte Sicherung" value={<Chip status="ok">heute 03:00</Chip>} meta="nächste 03:00" />
      </Cells>
    </Pane>
  </Workspace>
);

export const CanvasFillScreen = () => (
  <Workspace>
    <Pane
      label="Vorlage"
      head={
        <Bar
          start={
            <Text type="body" weight="strong">
              Angebot Küche Lindqvist
            </Text>
          }
        />
      }
      status={<StatusRow lead="Entwurf" facts={[{ value: 3, after: "Seiten" }]} />}
    >
      <Canvas label="Editor der Vorlage" height="fill">
        <div class="editor" style={{ height: "100%", overflow: "auto", background: "#fafafa" }}>
          <p>Sehr geehrte Frau Lindqvist,</p>
        </div>
      </Canvas>
    </Pane>
  </Workspace>
);
