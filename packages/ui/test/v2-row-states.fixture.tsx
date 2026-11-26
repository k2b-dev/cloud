import { createSignal } from "solid-js";
import {
  Bar,
  Button,
  Canvas,
  Chip,
  FilterBar,
  Inline,
  Input,
  List,
  Menu,
  Pane,
  Path,
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
