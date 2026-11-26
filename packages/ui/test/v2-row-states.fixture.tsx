import { Bar, Canvas, Chip, List, Pane, Row, Section, StatusRow, Text, Workspace } from "../src/v2";

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
