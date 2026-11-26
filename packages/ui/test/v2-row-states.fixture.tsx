import { Bar, Button, Canvas, Chip, Input, List, Pane, Path, Row, Section, StatusRow, Text, Workspace } from "../src/v2";

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

// `split`: the drawing's pane stands in a `Pane.Split` (a board or a calendar beside the place of its detail, W3 #4197).
export const CanvasFillScreen = (props: { split?: boolean }) => {
  const pane = () => (
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
  );
  return <Workspace>{props.split ? <Pane.Split>{pane()}</Pane.Split> : pane()}</Workspace>;
};

// A folder twelve levels deep, the last two with long names, in a head that also has a search and its deeds.
const levels = [
  "Werkstatt",
  "Projekte",
  "2026",
  "Kunden",
  "Lindqvist",
  "Küche",
  "Entwürfe",
  "Fronten",
  "Eiche geölt",
  "Muster",
  "Abnahme mit der Kundin am Werktisch",
  "Fotos der Musterfronten nach dem zweiten Ölen, Tageslicht",
];

export const deepPath = levels.map((label, index) => (index < levels.length - 1 ? { label, href: `#level-${index}` } : { label }));

export const DeepPathScreen = () => (
  <Workspace
    head={
      <Bar
        start={<Path label="Ort" items={deepPath} />}
        end={
          <>
            <Input type="search" icon="search" label="In diesem Ordner" placeholder="In diesem Ordner" />
            <Button icon="folder-plus" label="Neuer Ordner" />
            <Button variant="primary" icon="upload">
              Hochladen
            </Button>
          </>
        }
      />
    }
  >
    <Pane label="Fotos" status={<StatusRow lead="14 Dateien" />}>
      <Section title="Fotos" count={1}>
        <List label="Fotos">
          <Row lines={["Front_01.jpg"]} />
        </List>
      </Section>
    </Pane>
  </Workspace>
);
