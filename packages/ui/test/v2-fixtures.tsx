import type { JSX } from "solid-js";
import {
  Avatar,
  Band,
  Bar,
  Button,
  Canvas,
  Cells,
  Check,
  Chip,
  Choice,
  DateInput,
  Digest,
  Facts,
  Field,
  Group,
  Icon,
  Inline,
  Input,
  List,
  Nav,
  Notice,
  Pane,
  Path,
  Progress,
  Prose,
  RecordHead,
  Row,
  Section,
  Select,
  StatusRow,
  Steps,
  Table,
  Tabs,
  Text,
  Tiles,
  Workspace,
} from "../src/v2";

// Fixtures for the v2 browser tests: every primitive in the place where the mockup puts it, inside a workspace so its
// lines have column edges to reach. Only primitives, no CSS of their own, like an app.

const nav = (
  <Nav
    title="Mail"
    icon="mail"
    groups={[
      {
        label: "Postfächer",
        action: { label: "Postfächer verwalten", icon: "dots" },
        items: [
          { label: "Posteingang", icon: "inbox", current: true, count: 7 },
          { label: "Lieferanten", icon: "folder", nested: true },
          { label: "Rechnungen", icon: "mail", dot: "ok", count: 3 },
        ],
      },
    ]}
    foot={[{ label: "Ausgeblendet (2)", icon: "eye-off" }]}
  />
);

const shell = (children: JSX.Element, head?: JSX.Element) => (
  <Workspace sidebar={nav} sidebarLabel="Breite der Seitenleiste" head={head} primary={{ label: "Neu", icon: "plus" }}>
    {children}
  </Workspace>
);

/** Workspace, Pane, Pane.Split, Bar, Band, Cells, Tiles, Row, List, Notice, Inline, Chip, Avatar, Icon, Text, Prose. */
export const LayoutFixture = () =>
  shell(
    <Pane.Split>
      <Pane
        label="Breite der Liste"
        width={{ min: 320, default: 432 }}
        status={
          <StatusRow select={{ label: "Alle auswählen" }} lead="7 ungelesen" facts={[{ before: "Heute", value: 12, after: "erledigt" }]} />
        }
      >
        <List label="Nachrichten">
          <Row icon="file" lines={["Eine Zeile, 40 px"]} time="09:42" />
          <Row icon="file" lines={["Angebot", "zwei Zeilen, 52 px"]} selected />
          <Row
            unread
            lines={[
              "Holzwerk Brandt",
              "Angebot Eichenplatten – Liefertermin, dazu die Frage, ob die Kanten geölt kommen",
              "Guten Tag Frau Solberg, die Platten können wir in KW 49 liefern …",
            ]}
            meta="3"
            time="09:42"
            marks={
              <>
                <Chip tag color="#0f766e">
                  Angebot
                </Chip>
                <Icon name="paperclip" label="Anhang" />
                <Avatar name="Mira Solberg" color="#0f766e" />
              </>
            }
          />
          <Row
            yours
            strong
            icon="signature"
            lines={["Quittung wartet auf Unterschrift", "Q-2611-00021 · seit 18. Nov."]}
            action={{ label: "Zur Quittung" }}
          />
        </List>
      </Pane>
      <Pane
        detail
        label="Nachricht"
        head={
          <Bar
            start={<Text type="lead">Angebot Eichenplatten – Liefertermin</Text>}
            end={
              <>
                <Button icon="check">Erledigt</Button>
                <Button variant="ghost" icon="x" label="Schließen" />
              </>
            }
          />
        }
      >
        <Bar
          start={
            <Inline>
              <Text type="meta">3 Nachrichten</Text>
              <Chip status="warn">Wartet auf Antwort</Chip>
              <Chip icon="plus" onClick={() => undefined}>
                Tag
              </Chip>
            </Inline>
          }
          end={<Avatar name="Ada Renz" />}
        />
        <Notice tone="ai" title="Kurz gesagt" actions={[{ label: "Bearbeiten" }]}>
          Brandt liefert 14 Eichenplatten in KW 49.
        </Notice>
        <Band>
          <Row
            avatar={{ name: "Holzwerk Brandt", color: "#57534e" }}
            strong
            lines={["Holzwerk Brandt", "an Kontakt · heute, 09:42"]}
            end={<Button variant="ghost" icon="dots" label="Weitere Aktionen" />}
          />
          <Prose markdown={"Guten Tag Frau Solberg,\n\ndie 14 Platten können wir in KW 49 liefern."} />
          <Tiles items={[{ icon: "file-type-pdf", title: "Angebot-4471.pdf", meta: "212 KB" }]} more={{ label: "Alle herunterladen" }} />
        </Band>
        <Notice tone="note" title="Interne Notiz von Ada Renz" meta="gestern, 16:02">
          Brandt war bei der letzten Lieferung zwei Tage zu spät.
        </Notice>
        <Band tone="note">
          <Text type="body" weight="strong">
            Die erste Abrechnung kommt am 15. Dez.
          </Text>
          <Text>38 von 53 Artikeln sind verkauft.</Text>
        </Band>
        <Cells>
          <Cells.Cell icon="clock" label="Offen" value={12} />
          <Cells.Cell icon="check" label="Heute erledigt" value={31} href="#erledigt" />
          <Cells.Cell icon="currency-euro" color="#8e1b6f" label="Geld" value={<Chip amount="out">532,30 €</Chip>} meta="1 überfällig" />
        </Cells>
      </Pane>
    </Pane.Split>,
    <Bar
      start={
        <Tabs
          label="Ansichten"
          items={[
            { label: "Alle", count: 42, current: true },
            { label: "Handlungsbedarf", count: 5 },
          ]}
        />
      }
      end={
        <Button variant="primary" icon="pencil">
          Neue Nachricht
        </Button>
      }
    />,
  );

/** Section, Group, Digest, Facts, Table in a group, Canvas, RecordHead, Tabs as the head of a pane. */
export const StructureFixture = () =>
  shell(
    <Pane
      label="Akte"
      head={
        <Tabs
          label="Bereiche"
          items={[
            { label: "Überblick", icon: "layout-grid", current: true },
            { label: "Geld", icon: "currency-euro", count: 12 },
          ]}
        />
      }
    >
      <Pane.Split>
        <Pane label="Überblick">
          <Section icon="checklist" color="#2563eb" title="Anstehend" count={2} actions={[{ label: "Todo anlegen", icon: "plus" }]}>
            <Row strong icon="signature" lines={["Quittung wartet auf Unterschrift", "seit 18. Nov."]} action={{ label: "Zur Quittung" }} />
            <Row
              strong
              icon="packages"
              lines={["3 Artikel sind abholbereit", "bis 12. Dez."]}
              action={{ label: "Herausgabe vorbereiten" }}
            />
          </Section>
          <Section icon="list-details" color="#c2410c" title="Vorgänge" more={{ label: "Alle Einlieferungen", forward: true }}>
            <Digest
              items={[
                {
                  icon: "package",
                  color: "#c2410c",
                  date: "3. Nov.",
                  title: "EL-2611-00009",
                  state: { icon: "gavel", label: "Läuft" },
                  text: (
                    <>
                      8 Artikel laufen, die Auktion endet <Text weight="strong">morgen</Text>.
                    </>
                  ),
                },
              ]}
            />
          </Section>
          <Section icon="package" color="#c2410c" title="Einlieferungen" count={2} summary="10 Artikel sind ausgelaufen.">
            <Group
              icon="package"
              title="EL-2611-00009"
              count={18}
              meta="angekommen 3. Nov. · Post"
              state={<Chip status="ok">Läuft</Chip>}
              actions={[{ label: "Öffnen" }]}
            >
              <Text type="body" weight="strong">
                10 Artikel sind ausgelaufen.
              </Text>
              <Steps
                label="Weg der Einlieferung"
                items={[
                  { label: "Angekommen", meta: "3. Nov.", state: "done" },
                  { label: "Ausgelaufen", meta: "10 von 18", state: "now" },
                  { label: "Ausgezahlt", state: "next" },
                ]}
              />
              <Row
                icon="signature"
                strong
                lines={[
                  <>
                    Quittung <Text href="#quittung">Q-2611-00021</Text> wartet
                  </>,
                  "per Post gesendet am 18. Nov.",
                ]}
                end={
                  <Button variant="text" forward>
                    Zur Quittung
                  </Button>
                }
              />
              <Table
                label="Abrechnung"
                rows={[
                  { day: "15. Nov.", items: "10 Artikel", when: "15. Dez.", amount: "180,00 €" },
                  { day: "24. Nov.", items: "8 Artikel", when: "15. Jan.", amount: "offen" },
                ]}
                columns={[
                  { title: "Auslauftag", cell: (row) => [row.day, row.items] },
                  { title: "Abrechnung", cell: (row) => [row.when, <Progress value={5} of={22} label="Arbeitstag 5 von 22" />] },
                  { title: "Auszahlung", align: "end", cell: (row) => [row.amount, "geschätzt"] },
                ]}
              />
              <Facts
                inline
                items={[
                  { label: "Quittung", value: "Q-2611-00009" },
                  { label: "Vertrag", value: "VT-2610-00031" },
                ]}
                end={
                  <Button variant="text" icon="printer">
                    Drucken
                  </Button>
                }
              />
            </Group>
            <Group
              icon="package"
              title="EL-2609-00017"
              meta="ausgezahlt am 12. Nov."
              folded
              state={
                <Text weight="medium" tone="ok">
                  <Icon name="circle-check" /> Ausgezahlt
                </Text>
              }
              menu={{ label: "Weitere Aktionen" }}
            />
          </Section>
        </Pane>
        <Pane side label="Breite der Angaben" width={{ min: 280, default: 360 }}>
          <Canvas label="Karte" height={176}>
            <span />
          </Canvas>
          <Section
            icon="phone"
            title="Kontakt"
            actions={[{ label: "Ändern", icon: "pencil" }]}
            more={{ label: "Alle Angaben", meta: "Bank, Person" }}
          >
            <Facts
              items={[
                { label: "Telefon", value: "+49 30 5550 142", hint: "Standard", copy: "+49 30 5550 142" },
                { label: "Sprache", value: "Deutsch" },
              ]}
            />
          </Section>
        </Pane>
      </Pane.Split>
    </Pane>,
    <Bar
      start={
        <RecordHead
          name="Ottilie Brandner"
          avatar={{ name: "Ottilie Brandner", color: "#1d4ed8" }}
          kinds={["Privat"]}
          ids={[{ label: "Kunde", value: "7K4QX", copy: true }]}
        />
      }
      end={
        <Button variant="primary" icon="plus" menu>
          Neu
        </Button>
      }
    />,
  );

const longText =
  "Die Küche soll bis Ende Januar fertig sein; die Arbeitsplatte aus Eiche kommt in zwei Teilen und braucht eine Fuge über der Spüle";

/** Table with column widths, long text cut and one wrap column; chips and amounts in cells. */
export const TableFixture = () =>
  shell(
    <Pane label="Anfragen" status={<StatusRow lead="14 Anfragen" />}>
      <Table
        label="Anfragen"
        rows={[
          { title: longText, who: "Familie Oswald", note: longText, state: "ok" as const, sum: "1.280,00 €" },
          { title: "Treppe Haus am Hang", who: "Architekturbüro Winter", note: "kurz", state: "warn" as const, sum: "640,00 €" },
        ]}
        columns={[
          { title: "Titel", width: { min: 160, default: 260 }, cell: (row) => row.title },
          { title: "Kunde", width: { min: 120, default: 180 }, cell: (row) => row.who, drop: true },
          { title: "Notiz", width: { min: 200, default: 300 }, wrap: true, cell: (row) => row.note },
          {
            title: "Status",
            width: { min: 100, default: 140 },
            cell: (row) => <Chip status={row.state}>{row.state === "ok" ? "Gültig" : "Wartet"}</Chip>,
          },
          { title: "Betrag", width: { min: 100, default: 120 }, align: "end", cell: (row) => row.sum },
        ]}
      />
    </Pane>,
  );

const orders = Array.from({ length: 8 }, (_, index) => ({
  key: `AU-${100 + index}`,
  name: ["Einbauschrank Familie Oswald", "Treppe Haus am Hang", "Küche Lindqvist", "Esstisch Eiche massiv"][index % 4]!,
  state: index < 5 ? ("open" as const) : ("done" as const),
  person: { name: ["Mira Solberg", "Jule Amsel"][index % 2]!, color: ["#0f766e", "#7c3aed"][index % 2] },
  amount: `${(index + 1) * 180},50 €`,
}));

/** The large table: Path in the head, a selecting status row, box column, sticky first column, groups, sort, phone form. */
export const GridFixture = () =>
  shell(
    <Pane
      label="Aufträge"
      status={
        <StatusRow
          lead="8 Aufträge"
          select={{ label: "Alle Aufträge", checked: "mixed" }}
          selection={{ count: "1 ausgewählt", actions: [{ label: "Exportieren", icon: "download" }], clear: { label: "Auswahl aufheben" } }}
        />
      }
    >
      <Table
        label="Aufträge"
        rows={orders}
        rowKey={(order) => order.key}
        current="AU-102"
        sticky
        select={{ selected: ["AU-101"], onChange: () => undefined, all: "Alle Aufträge", row: (order) => order.name }}
        group={(order) => ({
          key: order.state,
          head: order.state === "open" ? <Chip status="warn">Offen</Chip> : <Chip status="ok">Erledigt</Chip>,
          meta: order.state === "open" ? "5 · 2.700,00 €" : "3 · 3.780,00 €",
          count: order.state === "open" ? "5" : "3",
        })}
        sort={{ column: 3, direction: "ascending" }}
        phone={(order) => ({ lines: [order.name, order.key], avatar: order.person, time: order.amount })}
        columns={[
          { title: "Auftrag", width: { min: 160, default: 260 }, cell: (order) => <Text weight="medium">{order.name}</Text> },
          {
            title: "Verantwortlich",
            width: { min: 120, default: 176 },
            cell: (order) => (
              <Inline>
                <Avatar {...order.person} />
                {order.person.name}
              </Inline>
            ),
          },
          {
            title: "Tags",
            width: { min: 120, default: 188 },
            cell: () => (
              <Inline>
                <Chip tag color="#b45309">
                  Eiche
                </Chip>
                <Chip tag color="#be123c">
                  Eilig
                </Chip>
              </Inline>
            ),
          },
          { title: "Betrag", align: "end", width: { min: 96, default: 120 }, cell: (order) => order.amount },
          { title: "Beleg", width: { min: 100, default: 140 }, cell: (order) => <Text href="#beleg">RE-{order.key}</Text> },
        ]}
      />
    </Pane>,
    <Bar start={<Path label="Ort" items={[{ label: "Werkstatt", href: "#werkstatt" }, { label: "Aufträge" }]} />} />,
  );

/** Field, Field.Row, Input, Select, DateInput, Check (box, switch; empty, set, mixed), Choice, Button variants. */
export const ControlsFixture = () =>
  shell(
    <Pane label="Formular">
      <Band>
        <Field.Row>
          <Field name="name" label="Name" hint="So heißt die Quelle.">
            <Input value="Lackfabrik Nordhaus" />
          </Field>
          <Field name="interval" label="Intervall" optional="Sekunden" error="Mindestens 60 Sekunden.">
            <Input type="number" value="30" />
          </Field>
        </Field.Row>
        <Field.Row>
          <Field name="kind" label="Art">
            <Select options={["Webhook", "Abruf"]} value="Abruf" />
          </Field>
          <Field name="start" label="Start">
            <DateInput value="24.11.2026" />
          </Field>
        </Field.Row>
      </Band>
      <Band>
        <Check name="empty" label="Benachrichtigen" />
        <Check name="set" label="Benachrichtigen" checked />
        <Check name="mixed" label="Alle Postfächer" checked="mixed" />
        <Check name="off" switch label="Aktiv" />
        <Check name="on" switch label="Aktiv" checked />
        <Choice name="every" label="Wie oft" options={["Täglich", "Wöchentlich"]} value="Täglich" />
      </Band>
      <Bar
        start={<Text>Aktionen</Text>}
        end={
          <>
            <Button variant="text" icon="plus">
              Text
            </Button>
            <Button variant="ghost" icon="dots" label="Weitere Aktionen" />
            <Button>Abbrechen</Button>
            <Button variant="primary" icon="check">
              Speichern
            </Button>
          </>
        }
      />
    </Pane>,
  );

/**
 * A thread of two messages, each a band of its parts (who, the text, the attachments), and a column whose status row
 * is the bar of a selection, for widths of the column from 360 to 640 px.
 */
const MessagesFixture = () => (
  <Workspace
    sidebarLabel="Breite der Seitenleiste"
    sidebar={<Nav title="Mail" icon="mail" groups={[{ items: [{ label: "Posteingang", icon: "inbox", count: 7, current: true }] }]} />}
  >
    <Pane
      label="Auswahl"
      status={
        <StatusRow
          lead="12 Nachrichten"
          selection={{
            count: "10 ausgewählt",
            actions: [
              { label: "Erledigt", icon: "check" },
              { label: "Archivieren", icon: "archive" },
              { label: "Löschen", icon: "trash" },
            ],
            clear: { label: "Auswahl aufheben" },
          }}
        />
      }
    >
      <Band>
        <Row
          avatar={{ name: "Holzwerk Brandt" }}
          strong
          lines={["Holzwerk Brandt", "an Kontakt · heute, 09:42"]}
          end={<Button variant="ghost" icon="dots" label="Weitere Aktionen" />}
        />
        <Prose markdown={"Guten Tag Frau Solberg,\n\ndie 14 Platten können wir in KW 49 liefern."} />
      </Band>
      <Band>
        <Row avatar={{ name: "Mira Solberg" }} strong lines={["Mira Solberg", "an Holzwerk Brandt · gestern"]} />
        <Prose markdown="Bitte schicken Sie uns das Angebot." />
        <Tiles items={[{ icon: "file-type-pdf", title: "Angebot-4471.pdf", meta: "212 KB" }]} />
      </Band>
      <Band>
        <Input multiline label="Antwort an Mira Solberg" placeholder="Antwort schreiben …" />
      </Band>
      <Section title="Rückfrage">
        <Field name="subject" label="Betreff" required>
          <Input placeholder="Worum geht es?" />
        </Field>
        <Choice name="channel" label="Antwort per" options={["E-Mail", "Telefon"]} value="E-Mail" />
      </Section>
      <Table
        label="Aufträge"
        rowKey={(order) => order.id}
        columns={[
          { title: "Auftrag", width: { min: 160, default: 240 }, cell: (order) => order.name },
          { title: "Betrag", width: { min: 80, default: 120 }, align: "end", cell: (order) => order.sum },
        ]}
        rows={[
          { id: "AU-1", name: "Einbauschrank Flur", sum: "180,50 €" },
          { id: "AU-2", name: "Treppe Haus am Hang", sum: "617,00 €" },
        ]}
        phone={(order) => ({ lines: [order.name, order.sum] })}
      />
    </Pane>
  </Workspace>
);

export const fixtures = {
  layout: LayoutFixture,
  structure: StructureFixture,
  table: TableFixture,
  grid: GridFixture,
  controls: ControlsFixture,
  messages: MessagesFixture,
} as const;
