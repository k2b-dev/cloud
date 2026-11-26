import { createSignal } from "solid-js";
import {
  Bar,
  Button,
  Canvas,
  Cells,
  Chip,
  Digest,
  Empty,
  Failed,
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
import { defineListQuery, field, type ListQueryStateOf } from "../src/v2/list-query";

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

// a folder of everyday names, as the Files app has it: its page ("Entwürfe") must never shorten (Files v3)
export const everydayPath = ["Werkstatt", "Projekte", "2026", "Kunden", "Lindqvist", "Küche", "Entwürfe"].map((label, index, all) =>
  index < all.length - 1 ? { label, href: `#place-${index}` } : { label },
);

export const deepPath = levels.map((label, index) => (index < levels.length - 1 ? { label, href: `#level-${index}` } : { label }));

// `chip`: the path stands in an `Inline` with a chip after it (the folder's sharing, W1b #4206).
export const DeepPathScreen = (props: { chip?: boolean }) => (
  <Workspace
    head={
      <Bar
        start={
          props.chip ? (
            <Inline>
              <Path label="Ort" items={everydayPath} />
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

// A selection with six deeds in a column beside a side column: the first three stand, the rest wait in "Mehr".
export const SelectionScreen = () => (
  <Workspace>
    <Pane.Split>
      <Pane
        label="Dateien"
        status={
          <StatusRow
            lead=""
            selection={{
              count: "3 ausgewählt",
              actions: [
                { label: "Teilen", icon: "share" },
                { label: "Verschieben", icon: "folder-symlink" },
                { label: "Als ZIP laden", icon: "download" },
                { label: "Löschen", icon: "trash" },
                { label: "In Ordner kopieren", icon: "copy" },
                { label: "PDFs zusammenführen", icon: "stack-2" },
              ],
              clear: { label: "Auswahl aufheben", onClick: () => {} },
            }}
          />
        }
      >
        <List label="Dateien">
          <Row lines={["Ansicht Front Eiche.jpg"]} />
        </List>
      </Pane>
      <Pane label="Vorschau" width={{ min: 320, default: 380 }}>
        <Text>Ansicht Front Eiche.jpg</Text>
      </Pane>
    </Pane.Split>
  </Workspace>
);

// The surroundings of a note that did not load: once loaded again, nothing matches its filter. Two ways out, the
// first the one that keeps the place (Notebooks W2 #4245); the focus on „Erneut versuchen“ goes to the first.
export const EmptyWaysScreen = () => {
  const [failed, setFailed] = createSignal(true);
  return (
    <Workspace>
      <Pane label="Umgebung">
        {failed() ? (
          <Failed text="Die Umgebung konnte nicht geladen werden." onRetry={() => setFailed(false)} />
        ) : (
          <Empty
            icon="filter-off"
            text="Keine Notizen in der Umgebung mit diesem Filter."
            action={{ label: "Filter zurücksetzen", onClick: () => {} }}
            secondary={{ label: "Ganzes Notizbuch zeigen", href: "#notizbuch" }}
          />
        )}
      </Pane>
    </Workspace>
  );
};

// A folder filtered by three people on the phone, with the menu of how the list shows: the statement is longer than
// the room between the filter button and that menu (Files, DR #4229).
const ownerQuery = defineListQuery({
  key: "owners",
  fields: {
    owner: field.choice({
      label: "Person",
      options: [
        { value: "felix", label: "Felix Thal" },
        { value: "mira", label: "Mira Solberg" },
        { value: "jonas", label: "Jonas Kern" },
      ],
      common: true,
    }),
  },
  sort: { options: { name: { label: "Name", directions: ["asc", "desc"] } }, default: { field: "name", direction: "asc" } },
});

export const ViewStatementScreen = () => {
  const [state, setState] = createSignal<ListQueryStateOf<typeof ownerQuery>>(ownerQuery.parse("owner=felix,mira,jonas").state);
  return (
    <Workspace>
      <Pane
        label="Dateien"
        status={
          <FilterBar
            query={ownerQuery}
            state={state()}
            onChange={setState}
            results="3 Einträge"
            display={[{ title: "Darstellung", choice: "list", onChoose: () => {}, items: [{ label: "Liste", value: "list" }] }]}
          />
        }
      >
        <List label="Dateien">
          <Row lines={["Angebot.pdf"]} />
        </List>
      </Pane>
    </Workspace>
  );
};

// A section that ends with its own bar of deeds ("Alle anzeigen"), above a second section: one line between them.
export const SectionFootScreen = () => (
  <Workspace>
    <Pane label="Werkstatt">
      <Section title="Anstehend" count={2}>
        <List label="Anstehend">
          <Row mark={{ initial: "Werkstatt", color: "#0284c7" }} lines={["Fronten ölen"]} time="heute" />
          <Row mark={{ icon: "ruler", color: "#0284c7" }} lines={["Aufmaß Küche"]} time="morgen" />
        </List>
        <Bar start={<Button variant="ghost">Ältere laden</Button>} end={<Button variant="ghost">Alle anzeigen</Button>} />
      </Section>
      <Section title="Zuletzt" count={1}>
        <List label="Zuletzt">
          <Row lines={["Angebot Lindqvist"]} time="09:40" />
        </List>
      </Section>
    </Pane>
  </Workspace>
);
