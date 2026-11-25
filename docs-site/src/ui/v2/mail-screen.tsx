import {
  Avatar,
  Band,
  Bar,
  Button,
  Canvas,
  Chip,
  Icon,
  Inline,
  Input,
  List,
  Nav,
  Notice,
  Pane,
  Prose,
  Row,
  StatusRow,
  Tabs,
  Text,
  Tiles,
  Workspace,
} from "@k2b/ui/v2";
import { For, Show } from "solid-js";
import { ComposerDrawing } from "./drawings";

// Mail, list with reader, as in the approved mockup (mail.html). Only primitives and layer-2 components of
// @k2b/ui/v2: no class, no style, no CSS of its own. The composer comes from @k2b/editor later; until then it is a
// drawing in a Canvas.

const teal = "#0f766e";

const mails = [
  {
    from: "Holzwerk Brandt",
    count: "3",
    at: "09:42",
    subject: "Angebot Eichenplatten – Liefertermin",
    preview: "Guten Tag Frau Solberg, die Platten können wir in KW 49 liefern …",
    selected: true,
    marks: () => (
      <>
        <Chip tag color={teal}>
          Angebot
        </Chip>
        <Icon name="paperclip" label="Anhang" />
        <Avatar name="Mira Solberg" color={teal} />
      </>
    ),
  },
  {
    from: "Jonas Hartwig",
    at: "09:15",
    subject: "Frage zur Rechnung 2026-1184",
    preview: "Hallo, auf der Rechnung steht ein anderer Betrag als im Angebot …",
    unread: true,
    marks: () => (
      <Chip tag color="#b45309">
        Rechnung
      </Chip>
    ),
  },
  {
    from: "Stadtwerke Auental",
    at: "08:50",
    subject: "Zählerwechsel am 02.12.",
    preview: "Sehr geehrte Damen und Herren, wir tauschen an diesem Tag …",
    unread: true,
    marks: () => (
      <>
        <Icon name="clock" />
        bis Mo.
      </>
    ),
  },
  {
    from: "Petra Lindqvist",
    count: "2",
    at: "gestern",
    subject: "Küche Maß nehmen – Terminvorschlag",
    preview: "Dienstag oder Donnerstag ab 16 Uhr würde bei uns passen …",
    marks: () => (
      <>
        Wartet
        <Avatar name="Frieda Thal" color="#c2410c" />
      </>
    ),
  },
  {
    from: "Lackfabrik Nordhaus",
    at: "gestern",
    subject: "Preisliste 2027",
    preview: "Anbei erhalten Sie unsere neue Preisliste, gültig ab 1. Januar …",
    unread: true,
    marks: () => <Icon name="paperclip" label="Anhang" />,
  },
  {
    from: "Architekturbüro Winter",
    count: "4",
    at: "Mi.",
    subject: "Re: Treppe Haus am Hang",
    preview: "Danke für die Zeichnung. Wir brauchen noch die Höhe des …",
    marks: () => (
      <>
        <Text tone="draft">Entwurf</Text>
        <Avatar name="Jan Kessler" color="#7c3aed" />
      </>
    ),
  },
  {
    from: "Bauhof Nordtal",
    at: "Mi.",
    subject: "Abholung Altholz",
    preview: "Der Container steht ab Montag bereit, Abholung nach Anruf.",
  },
  {
    from: "Familie Oswald",
    at: "Di.",
    subject: "Erinnerung: offenes Angebot Einbauschrank",
    preview: "Das Angebot vom 02.11. läuft am 30.11. aus. Soll ich …",
    marks: () => (
      <Text tone="ai">
        <Icon name="sparkles" /> Vorschlag
      </Text>
    ),
  },
  {
    from: "Karla Oswald",
    at: "Mo.",
    subject: "Bewerbung um einen Ausbildungsplatz",
    preview: "Sehr geehrte Frau Renz, hiermit bewerbe ich mich …",
    marks: () => (
      <>
        <Chip tag color="#7c3aed">
          Personal
        </Chip>
        <Icon name="paperclip" label="Anhang" />
        <Icon name="lock" label="Vertraulich" />
      </>
    ),
  },
  {
    from: "Spedition Falk",
    at: "Mo.",
    subject: "Lieferavis 4471",
    preview: "Ihre Sendung wird am 23.11. zwischen 7 und 11 Uhr zugestellt.",
  },
];

// The message as Markdown; a backslash at the end of a line breaks it, as the signature does.
const message = [
  "Guten Tag Frau Solberg,",
  "die 14 Platten können wir in KW 49 liefern, wenn die Bestellung bis Freitag bei uns ist. Der Preis aus dem Angebot bleibt bis dahin gültig. Die Lieferung kommt auf zwei Paletten, bitte halten Sie die Einfahrt frei.",
  "Freundliche Grüße\\\nHenrik Brandt",
].join("\n\n");

// What is open is in the address, as in the app: the screen "mail" opens Brandt's message (the list beside it on a wide
// screen; on the phone the message is the page, with the way back), "mail-list" opens nothing (the phone's first page).
// Only Brandt's row opens, since the demo has one message to read.
const screen = "/en/ui/v2/screen";

export const MailScreen = (props: { open?: boolean }) => (
  <Workspace
    sidebarLabel="Breite der Seitenleiste"
    primary={{ label: "Neu", icon: "pencil" }}
    sidebar={
      <Nav
        title="Mail"
        icon="mail"
        groups={[
          {
            label: "Postfächer",
            action: { label: "Postfächer verwalten", icon: "dots" },
            items: [
              { label: "Kontakt", icon: "flag" },
              { label: "Posteingang", icon: "inbox", nested: true, current: true, count: 7 },
              { label: "Entwürfe", icon: "file-pencil", nested: true, count: 2 },
              { label: "Postausgang", icon: "calendar-time", nested: true, count: 1 },
              { label: "Gesendet", icon: "send", nested: true },
              { label: "Mehr", icon: "chevron-right", nested: true },
              { label: "Lieferanten", icon: "folder", nested: true },
              { label: "Reklamationen", icon: "folder", nested: true },
              { label: "Rechnungen", icon: "mail", dot: "ok", count: 3 },
              { label: "Personal", icon: "mail" },
              { label: "Mira Solberg", icon: "mail", dot: "ok" },
            ],
          },
        ]}
        foot={[{ label: "Ausgeblendet (2)", icon: "eye-off" }]}
      />
    }
    head={
      <Bar
        start={
          <Tabs
            label="Ansichten"
            items={[
              { label: "Alle", count: 42, current: true },
              { label: "Handlungsbedarf", count: 5 },
              { label: "Mir zugewiesen", count: 3 },
              { label: "Wartet auf Antwort", count: 4 },
              {
                label: "Weitere",
                count: "+5",
                menu: [
                  { label: "Erledigt", href: `${screen}/mail` },
                  { label: "Später", href: `${screen}/mail` },
                  { label: "Entwürfe", href: `${screen}/mail` },
                  { label: "Gesendet", href: `${screen}/mail` },
                  { label: "Spam", href: `${screen}/mail` },
                ],
              },
            ]}
          />
        }
        end={
          <>
            <Input type="search" icon="search" placeholder="Suchen" label="Suchen" />
            <Button variant="ghost" icon="dots" label="Weitere Aktionen" />
            <Button variant="primary" icon="pencil">
              Neue Nachricht
            </Button>
          </>
        }
      />
    }
  >
    <Pane.Split>
      <Pane
        label="Breite der Liste"
        width={{ min: 320, default: 432 }}
        status={
          <StatusRow
            select={{ label: "Alle auswählen" }}
            lead="7 ungelesen"
            facts={[{ before: "Heute", value: 12, after: "erledigt · 5 davon automatisch" }]}
          />
        }
      >
        <List label="Nachrichten">
          <For each={mails}>
            {(mail) => (
              <Row
                lines={[mail.from, mail.subject, mail.preview]}
                meta={mail.count}
                time={mail.at}
                unread={mail.unread}
                selected={mail.selected && props.open !== false}
                href={mail.selected ? `${screen}/mail` : undefined}
                marks={mail.marks?.()}
              />
            )}
          </For>
        </List>
      </Pane>
      <Show when={props.open !== false}>
        <Pane
          detail
          back={{ label: "Posteingang", href: `${screen}/mail-list` }}
          label="Nachricht"
          head={
            <Bar
              start={<Text type="lead">Angebot Eichenplatten – Liefertermin</Text>}
              end={
                <>
                  <Button icon="check">Erledigt</Button>
                  <Button variant="ghost" icon="archive" label="Archivieren" />
                  <Button variant="ghost" icon="trash" label="Löschen" />
                  <Button variant="ghost" icon="clock" label="Später" />
                  <Button variant="ghost" avatar={{ name: "Mira Solberg", color: teal }} label="Zugewiesen an Mira Solberg" />
                  <Button variant="ghost" icon="dots" label="Weitere Aktionen" />
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
                <Chip tag color={teal}>
                  Angebot
                </Chip>
                <Chip icon="link" href="#verknuepft">
                  1 verknüpft
                </Chip>
                <Chip icon="plus" onClick={() => undefined}>
                  Tag
                </Chip>
              </Inline>
            }
            end={
              <>
                <Avatar name="Ada Renz" color="#be123c" />
                <Text type="meta">Ada Renz liest mit</Text>
              </>
            }
          />
          <Notice tone="ai" title="Kurz gesagt" actions={[{ label: "Bearbeiten" }]}>
            Brandt liefert 14 Eichenplatten in KW 49, wenn bis Freitag bestellt wird. Offen ist nur, ob die Kanten geölt kommen.
          </Notice>
          <Canvas label="Antwort an Holzwerk Brandt">
            <ComposerDrawing />
          </Canvas>
          <Band>
            <Row
              avatar={{ name: "Holzwerk Brandt", color: "#57534e" }}
              strong
              lines={["Holzwerk Brandt", "an Kontakt · heute, 09:42"]}
              meta="einkauf@holzwerk-brandt.example"
              end={
                <>
                  <Button variant="ghost" icon="arrow-back-up" label="Antworten" />
                  <Button variant="ghost" icon="dots" label="Weitere Aktionen" />
                </>
              }
            />
            <Prose markdown={message} />
            <Tiles
              label="Anhänge"
              items={[
                { icon: "file-type-pdf", title: "Angebot-4471.pdf", meta: "212 KB" },
                { icon: "file-type-pdf", title: "Lieferbedingungen.pdf", meta: "96 KB" },
              ]}
              more={{ label: "Alle herunterladen" }}
            />
          </Band>
          <Notice tone="note" title="Interne Notiz von Ada Renz" meta="gestern, 16:02">
            Brandt war bei der letzten Lieferung zwei Tage zu spät. Bitte Termin schriftlich bestätigen lassen.
          </Notice>
        </Pane>
      </Show>
    </Pane.Split>
  </Workspace>
);
