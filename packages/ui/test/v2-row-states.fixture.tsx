import { createSignal } from "solid-js";
import {
  Bar,
  Button,
  Canvas,
  Cells,
  Chip,
  Digest,
  FilterBar,
  Group,
  Inline,
  Input,
  List,
  Menu,
  Notice,
  Pane,
  Path,
  Prose,
  Row,
  Section,
  StatusRow,
  Text,
  Workspace,
} from "../src/v2";
import { defineListQuery, type ListQueryStateOf } from "../src/v2/list-query";

// Rows whose states must be read whole (the domain checks of the administration, S2 #4174), in their worst case: many
// states, a state longer than the row, rows with and without states side by side. Beside it a drawing that is the
// whole pane (an editor, a frame of another page), which takes the pane's height by layout alone.

const domain = { icon: "world", color: "#0284c7" };

export const RowStatesScreen = () => (
  <Workspace>
    <Pane label="Domains" status={<StatusRow lead="4 Domains" facts={[{ value: 2, after: "mit Lücken" }]} />}>
      <Section title="Domains" count={4}>
        <List label="Domains">
          <Row mark={domain} lines={["example.org"]} time="geprüft 09:40" />
          <Row
            mark={domain}
            lines={["mail.example.org"]}
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
            lines={["werkstatt.handwerk-und-restaurierung-am-alten-markt.example.org", "Weiterleitung auf example.org"]}
            states={
              <>
                <Chip status="bad">
                  Zertifikat läuft in 3 Tagen ab: werkstatt.handwerk-und-restaurierung-am-alten-markt.example.org, erneuern
                </Chip>
                <Chip status="ok">SPF gültig</Chip>
              </>
            }
          />
          <Row mark={domain} lines={["alt.example.org", "stillgelegt seit 01.10.2026"]} />
        </List>
      </Section>
    </Pane>
  </Workspace>
);

// Key numbers in their worst case (lane C, gateway-ops #4205): long labels, big numbers, an amount chip, a trend, and
// four cells beside three.
// `narrow`: the same cells in a pane of about 600 px beside a wide side column, on the desktop (review r5).
export const CellsScreen = (props: { narrow?: boolean }) => {
  const cells = () => (
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
        <Cells.Cell icon="database" label="Speicher" value="38,2 von 100 GB" meter={{ value: 38.2, of: 100 }} meta="Werkstatt" />
        <Cells.Cell icon="users" label="Konten" value="192" meta="23 Gäste" />
        <Cells.Cell icon="clock" label="Letzte Sicherung" value={<Chip status="ok">heute 03:00</Chip>} meta="nächste 03:00" />
      </Cells>
      {/* five and six: rows of three in a narrow pane, two to a row on the phone, never one tall cell alone */}
      <Cells>
        {["Offen", "In Arbeit", "Wartet", "Fertig", "Abgeholt"].map((label, index) => (
          <Cells.Cell icon="circle" label={label} value={String(12 + index * 7)} meta="diese Woche" />
        ))}
      </Cells>
      <Cells>
        {["Mo", "Di", "Mi", "Do", "Fr", "Sa"].map((label, index) => (
          <Cells.Cell icon="calendar" label={label} value={`${31 + index} Termine`} />
        ))}
      </Cells>
    </Pane>
  );
  return (
    <Workspace>
      {props.narrow ? (
        <Pane.Split>
          {cells()}
          <Pane label="Notizen" width={{ min: 320, default: 820 }}>
            <Text>Notizen zur Übersicht</Text>
          </Pane>
        </Pane.Split>
      ) : (
        cells()
      )}
    </Workspace>
  );
};

// `split`: the drawing's pane stands in a `Pane.Split` (a board or a calendar beside the place of its detail, W3 #4197).
// `list`: a long list stands in the split too, one under the other on the phone; it must not squeeze the drawing.
export const CanvasFillScreen = (props: { split?: boolean; list?: boolean }) => {
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
  const list = () => (
    <Pane label="Seiten">
      <List label="Seiten">
        {Array.from({ length: 40 }, (_, index) => (
          <Row lines={[`Seite ${index + 1}`]} />
        ))}
      </List>
    </Pane>
  );
  return (
    <Workspace>
      {props.split ? (
        <Pane.Split>
          {props.list ? list() : undefined}
          {pane()}
        </Pane.Split>
      ) : (
        pane()
      )}
    </Workspace>
  );
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

// `chip`: the path stands in an `Inline` with a chip after it (the folder's sharing, W1b #4206).
export const DeepPathScreen = (props: { chip?: boolean }) => (
  <Workspace
    head={
      <Bar
        start={
          props.chip ? (
            <Inline>
              <Path label="Ort" items={deepPath} />
              <Chip icon="users">Mit 4 Personen geteilt</Chip>
            </Inline>
          ) : (
            <Path label="Ort" items={deepPath} />
          )
        }
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
    <Pane
      label="Fotos"
      // a short path: names narrower than the 48 px a long one shortens to keep their own width
      head={
        <Bar
          start={<Path label="Quartal" items={[{ label: "Werkstatt", href: "#w" }, { label: "2026", href: "#j" }, { label: "Q1" }]} />}
        />
      }
      status={<StatusRow lead="14 Dateien" />}
    >
      <Section title="Fotos" count={1}>
        <List label="Fotos">
          <Row lines={["Front_01.jpg"]} />
        </List>
      </Section>
    </Pane>
  </Workspace>
);

// A list whose search already fills the address almost to its limit: a sort more would not fit, so the phone's menu
// "Ansicht" locks it as the order's own menu does.
const longQuery = defineListQuery({
  key: "long",
  fields: {},
  search: { label: "Name" },
  sort: {
    options: { name: { label: "Name", directions: ["asc", "desc"] }, changed: { label: "Geändert", directions: ["desc", "asc"] } },
    default: { field: "name", direction: "asc" },
  },
});

export const LongAddressScreen = () => {
  const [state, setState] = createSignal<ListQueryStateOf<typeof longQuery>>(longQuery.parse(`q=${"x".repeat(1995)}`).state);
  return (
    <Workspace>
      <Pane
        label="Dateien"
        status={
          <FilterBar
            query={longQuery}
            state={state()}
            onChange={setState}
            results="0 Einträge"
            display={[{ title: "Darstellung", choice: "list", onChoose: () => {}, items: [{ label: "Liste", value: "list" }] }]}
          />
        }
      >
        <Section title="Dateien" count={0}>
          <List label="Dateien">{[]}</List>
        </Section>
      </Pane>
    </Workspace>
  );
};

// The areas of a notebook in a menu, each in its colour: a pale one, a strong one, one with its symbol, an oklch() one
// the stylesheet cannot work out, and a value that is no colour.
export const AreasMenuScreen = () => (
  <Workspace
    head={
      <Bar
        start={<Text weight="strong">Notizbuch</Text>}
        end={
          <Menu
            label="Bereich"
            items={[
              { label: "Werkstatt", color: "#fef08a" },
              { label: "Kunden", color: "#2563eb" },
              { label: "Einkauf", icon: "shopping-cart", color: "#22c55e" },
              { label: "Archiv", color: "oklch(0.62 0.17 145)" },
              { label: "Ohne Farbe", color: "#008f4c;position:fixed;inset:0" },
            ]}
          >
            Bereich
          </Menu>
        }
      />
    }
  >
    <Pane label="Notizen">
      <Section title="Notizen" count={0}>
        <List label="Notizen">{[]}</List>
      </Section>
    </Pane>
  </Workspace>
);

// The home of a place: its sections side by side, a group with its head, what people did (with and without a place),
// and a form's deeds as the foot of the column.
export const StructureScreen = () => (
  <Workspace>
    <Pane label="Werkstatt">
      <Section.Columns>
        <Section title="Anstehend" count={2}>
          <Group icon="tool" title="Küche Lindqvist" count={3}>
            <Row lines={["Fronten ölen"]} time="heute" />
          </Group>
        </Section>
        <Section title="Zuletzt">
          <Digest
            activity={[
              { person: { name: "Felix Thal" }, text: "Felix Thal hat Aufmaß Küche geändert", time: "vor 2 Min." },
              { person: { name: "Mira Solberg" }, text: "Mira Solberg hat Fronten angelegt", time: "09:40", place: "Werkstatt" },
            ]}
          />
        </Section>
      </Section.Columns>
      <Bar end={<Button variant="primary">Speichern</Button>} />
    </Pane>
  </Workspace>
);

// Code in prose: a word in code, a block of code, and a CodeBlock's line (`.k2-code`), which draws its own lines.
export const ProseCodeScreen = () => (
  <Workspace>
    <Pane label="Anleitung">
      <Prose>
        <p>
          Setze <code>AUTH_URL</code> auf die Adresse der Cloud.
        </p>
        <pre>
          <code>{"curl -H 'Authorization: Bearer …' https://cloud.example.org/api/me"}</code>
        </pre>
        <div class="k2-code">
          <div class="k2-code-line">
            <code>bun run dev</code>
          </div>
        </div>
      </Prose>
    </Pane>
  </Workspace>
);

// Groups in their two places: inside a Section (the section's line is enough, so a group draws no frame there) and
// directly in a pane under a notice (framed, apart from the notice's line).
const delivery = (id: string, text: string) => (
  <Group icon="package" title={id} count={6} state={<Chip status="warn">Wartet auf Abholung</Chip>}>
    <Text>{text}</Text>
  </Group>
);
export const GroupsScreen = () => (
  <Workspace>
    <Pane label="Einlieferungen">
      <Section title="Einlieferungen" count={2}>
        {delivery("EL-2611-00009", "10 Artikel sind ausgelaufen.")}
        {delivery("EL-2610-00031", "2 Artikel warten auf Abholung bis 12. Dez.")}
      </Section>
      <Notice tone="warn" title="Zwei Einlieferungen ohne Abteilung">
        Sie stehen hier, bis eine Abteilung sie übernimmt.
      </Notice>
      {delivery("EL-2609-00017", "Ohne Abteilung seit 3. Nov.")}
      {delivery("EL-2609-00018", "Ohne Abteilung seit 4. Nov.")}
    </Pane>
  </Workspace>
);
