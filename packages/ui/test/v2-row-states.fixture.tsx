import { createSignal } from "solid-js";
import {
  Band,
  Bar,
  Button,
  Canvas,
  Chip,
  Dialog,
  Empty,
  Failed,
  Field,
  FilterBar,
  Inline,
  Input,
  List,
  Menu,
  Notice,
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

/**
 * A chat as the Assistant draws it (W7): a column that asks for no height of its own, its history far taller than the
 * phone and scrolling inside, over the composer.
 */
const ChatDrawing = () => (
  <div class="chat" style={{ display: "flex", "flex-direction": "column", "min-height": "0" }}>
    <div class="chat-history" style={{ flex: "1", "min-height": "0", overflow: "auto" }}>
      {Array.from({ length: 60 }, (_, index) => (
        <p style={{ margin: "0", padding: "12px 16px" }}>Nachricht {index + 1} im Verlauf</p>
      ))}
    </div>
    <textarea class="chat-composer" aria-label="Nachricht" rows={2} style={{ margin: "8px 16px", "flex-shrink": "0" }} />
  </div>
);

// `split`: the drawing's pane stands in a `Pane.Split` (a board or a calendar beside the place of its detail, W3 #4197).
// `list`: a long list stands in the split too, one under the other on the phone; it must not squeeze the drawing.
// `tall`: the drawing's content is taller than the split (the days of a calendar on the phone): its pane keeps the
// split's height and scrolls inside, never growing past it (W3, Spaces' phone calendar).
// `chat`: the drawing is a chat whose history is far taller than the phone (W7).
export const CanvasFillScreen = (props: { split?: boolean; list?: boolean; tall?: boolean; chat?: boolean }) => {
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
        {props.chat ? (
          <ChatDrawing />
        ) : props.tall ? (
          <div class="calendar" style={{ height: "100%", overflow: "auto" }}>
            <div class="days" style={{ height: "1260px", background: "#fafafa" }}>
              <p>Montag</p>
            </div>
          </div>
        ) : (
          <div class="editor" style={{ height: "100%", overflow: "auto", background: "#fafafa" }}>
            <p>Sehr geehrte Frau Lindqvist,</p>
          </div>
        )}
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

// A selection with six deeds in a column beside a side column: the first three stand, the rest wait in "Mehr".
// `four`: four deeds with long words and the size of the selection, as Files shows them (W1b #4206 r5)
export const SelectionScreen = (props: { four?: boolean }) => (
  <Workspace>
    <Pane.Split>
      <Pane
        label="Dateien"
        status={
          <StatusRow
            lead=""
            selection={{
              count: props.four ? "3 ausgewählt · 12,4 MB" : "3 ausgewählt",
              actions: props.four
                ? [
                    { label: "Teilen", icon: "share" },
                    { label: "Herunterladen", icon: "download" },
                    { label: "In den Ordner verschieben", icon: "folder-symlink" },
                    { label: "In den Papierkorb", icon: "trash" },
                  ]
                : [
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

// The worst case of an invitation dialog on the phone (Spaces, W3): a notice of many lines above a field, and a list of
// addresses as chips in a band, one of them longer than the dialog.
export const InvitationScreen = () => (
  <Workspace>
    <Pane label="Termin">
      <Text>Jahresinventur</Text>
    </Pane>
    <Dialog title="Einladung vorbereiten" open onOpenChange={() => {}} foot={<Button variant="primary">Weiter in Mail</Button>}>
      <Notice tone="note" title="Vor dem Senden prüfen">
        Jährliche Sicherheitsunterweisung für alle Lagermitarbeitenden einschließlich der Aushilfen und der Nachtschicht · Noch wird nichts
        gesendet. Wer diese Einladung schon bekommen hat, bekommt eine Änderung statt einer neuen.
      </Notice>
      <Field label="Postfach">
        <Input value="Lagerlogistik Nord – Disposition, Wareneingang und Versand" />
      </Field>
      <Band label="Teilnehmende">
        <Inline>
          {[
            "bartholomew.fitzgerald@northwind-industries-holdings.example.com",
            "a@b.test",
            "first.last+billing@example.com",
            ...Array.from({ length: 12 }, (_, index) => `mitglied${index}@example.com`),
          ].map((address) => (
            <Chip icon="x" onClick={() => {}}>
              {address}
            </Chip>
          ))}
        </Inline>
      </Band>
    </Dialog>
  </Workspace>
);
