import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { Bar, Button, Chip, Cut, Input, List, Menu, Notice, Pane, Row, Table, Tabs, Workspace } from "../src/v2";

// Worst-case states of v2 primitives that change after the page is live (break-ui 25.11., review of #4210): a note that
// grows, a tab that becomes the open one, words cut in the middle in a narrow box, an amount among a row's marks.

declare global {
  interface Window {
    __k2Mounted?: boolean;
    /** Adds two lines to the note. */
    __k2GrowNote?: () => void;
    /** Opens the tab of this name. */
    __k2OpenTab?: (label: string) => void;
    /** The hint a person gets while the pointer rests on the middle of this line: the title of the element it hits. */
    __k2HintOf?: (line: HTMLElement) => string | null;
  }
}

window.__k2HintOf = (line) => {
  const box = line.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  // the element the pointer hits there, such as the link that opens a row and lies over its lines
  const hit = document.elementFromPoint(x, y);
  if (!hit) return null;
  hit.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x, clientY: y }));
  return hit.getAttribute("title");
};

const [note, setNote] = createSignal(["Erste Zeile", "Zweite Zeile", "Dritte Zeile", "Vierte Zeile"].join("\n"));
window.__k2GrowNote = () => setNote((text) => `${text}\nFünfte Zeile\nSechste Zeile`);
const views = ["Alle", "Handlungsbedarf", "Mir zugewiesen", "Wartet auf Antwort", "Erledigt", "Archiv", "Entwürfe"];
const [current, setCurrent] = createSignal("Alle");
window.__k2OpenTab = setCurrent;

const root = document.getElementById("root");
if (!root) throw new Error("worst: #root is missing");
// `<body data-case="table">`: a folder as a large table (Files), in groups, whose phone rows carry a date
const files = [
  { id: "f1", name: "Angebote", kind: "Ordner", detail: "Ordner · Link", changed: "25.11.2026, 14:32" },
  {
    id: "f2",
    // a name longer than a phone row: its first line stays one line (M, #4324)
    name: "Zuschnitt Küchenfront Eiche geölt für Familie Brandt, zweite Fassung nach dem Aufmaß vom 12. November, mit den Maßen der Werkstatt Nord, Kanten in Eiche massiv und Griffleisten aus Messing.dxf",
    kind: "Dateien",
    detail: "1.000 KB · Team",
    changed: "1.11.2026, 09:05",
  },
  {
    id: "f3",
    name: "Stripe Zahlungen",
    kind: "Dateien",
    detail: `{"id":"evt_3QxK8m","type":"payment_intent.succeeded","data":${"x".repeat(240)}}`,
    changed: "heute, 11:26",
  },
];
const [picked, setPicked] = createSignal<readonly string[]>([]);
const [marked, setMarked] = createSignal(true);
// `<body data-case="head">`: a head on the phone that holds views, a search, a filter and two deeds that keep their words
const scenario = document.body.dataset.case;
// `<body data-case="rows">`: endpoints whose second line is an address of 300 characters without a break, beside a deed
const address = `https://cloud.example.test/tools/api/webhooks/receive/${"segmentwithoutanybreak".repeat(12)}`;
const hyphened = `https://cloud.example.test/tools/api/webhooks/receive/${"segment-with-breaks-".repeat(12)}end`;
// `<body data-case="notes">`: what the Assistant remembers (W7), as rows of one and of two lines whose text runs to
// 600 signs; each title is one line (two for a row of one on the phone), its text whole on hover
const memory = `Valentin möchte Angebote immer zuerst als Entwurf sehen, mit den Maßen der Werkstatt, ${"dem Holz, der Oberfläche und dem Liefertermin, ".repeat(10)}bevor etwas an Kundinnen geht.`;
// `<body data-case="chats">`: a list of chats (W9) whose names and last messages run long, each with a time and a deed;
// every row keeps one height: one line of name, one line of message
const chats = [
  {
    name: "Nora Weber",
    text: "One more thing: the invoice lists 12 chairs, we ordered 10. I will ask them to correct it before we pay anything, and then we can talk about the delivery date and the second table.",
  },
  {
    name: "Lieferung KW 49 · Werkstatt Nord, Abholung Montag früh mit dem großen Transporter, danach Küchenfront, Zuschnitt und Montage beim Kunden in Leipzig, Abnahme mit dem Bauleiter und Rechnung an die Hausverwaltung am Freitag",
    text: "Abholung Montag",
  },
  { name: "Ada", text: `Log: ${"payment_intent.succeeded".repeat(8)}` },
  { name: "Jonas Keller", text: "Ok" },
  // as long as a title of a row of two may be without a hint: it fits beside the time in the narrowest column
  { name: "Mira Solberg-Hoffman", text: "Bis morgen", time: "Gestern" },
  // a long name with a count beside it, and an address as a name (W9 break-ui): one line each, the count beside the name
  { name: "Maximiliane Alexandra von Hohenzollern-Sigmaringen-Wittelsbach", text: "You: Already done.", meta: "86" },
  { name: "projektabstimmung.lieferanten.werkstatt-nord@example.org", text: "Can you send photos to the supplier?" },
  // user text in a script of the other direction (W9 break-ui): each line runs in its own direction, "…" at its end
  {
    name: "مستودع القاهرة",
    text: "تم تأجيل التسليم إلى يوم الاثنين بسبب عطل في المستودع، يرجى إبلاغ العملاء وتحديث الجدول الزمني للطلبات المفتوحة قبل نهاية الأسبوع. ".repeat(
      3,
    ),
  },
  {
    name: "מחסן תל אביב",
    text: "המשלוח נדחה ליום שני בגלל תקלה במחסן, נא לעדכן את הלקוחות ואת לוח הזמנים של ההזמנות הפתוחות לפני סוף השבוע. ".repeat(3),
  },
];
// `<body data-case="mail">`: conversations of Mail, one without a preview (Mail passes " "): one height for both
if (scenario === "mail")
  render(
    () => (
      <Workspace>
        <Pane label="Spalte">
          <List label="Unterhaltungen">
            <Row
              avatar={{ name: "Ada Renz" }}
              lines={["Ada Renz", "Angebot Küche", "Die Maße passen, bitte noch die Griffe."]}
              time="09:12"
            />
            <Row avatar={{ name: "Bruno Keller" }} lines={["Bruno Keller", "Rechnung November", " "]} time="08:40" />
          </List>
        </Pane>
      </Workspace>
    ),
    root,
  );
// `<body data-case="deeds">`: endpoints of Tools with their one deed and the time they were last called (W1b): on the
// phone the time and the deed share the line under the text
else if (scenario === "deeds")
  render(
    () => (
      <Workspace>
        <Pane label="Spalte">
          <List label="Endpunkte">
            <Row
              icon="webhook"
              lines={["Stripe Zahlungen", "https://cloud.example.test/tools/api/webhooks/receive/stripe"]}
              time="zuletzt heute, 11:29"
              action={{ label: "Adresse kopieren", onClick: () => undefined }}
            />
            <Row icon="webhook" lines={["Lieferanten", "https://cloud.example.test/tools/api/webhooks/receive/suppliers"]} />
          </List>
        </Pane>
      </Workspace>
    ),
    root,
  );
else if (scenario === "chats")
  render(
    () => (
      <Workspace>
        <Pane label="Spalte">
          <List label="Chats">
            {chats.map((chat) => (
              <Row
                avatar={{ name: chat.name }}
                lines={[chat.name, chat.text]}
                href={`#chat-${chat.name.length}`}
                meta={chat.meta}
                time={chat.time ?? "11:45"}
                end={<Button variant="ghost" icon="dots" label={`Mehr zu ${chat.name}`} />}
              />
            ))}
          </List>
        </Pane>
      </Workspace>
    ),
    root,
  );
else if (scenario === "notes")
  render(
    () => (
      <Workspace>
        <Pane label="Spalte">
          <List label="Erinnerungen">
            <Row icon="brain" lines={[memory]} />
            <Row icon="brain" lines={[memory, "gemerkt am 26. Nov."]} time="heute" />
            <Row icon="brain" lines={["Kurz gemerkt"]} />
            {/* a row of one line with a time and a deed: each takes a place of its own (W1b) */}
            <Row
              icon="brain"
              lines={["Mit Zeit und Aktion"]}
              time="heute, 11:20"
              end={<Button variant="ghost" icon="dots" label="Mehr zu Mit Zeit und Aktion" />}
            />
          </List>
        </Pane>
      </Workspace>
    ),
    root,
  );
else if (scenario === "rows")
  render(
    () => (
      <Workspace>
        <Pane label="Spalte">
          <List label="Endpunkte">
            <Row
              icon="webhook"
              lines={["Zahlungseingänge der Buchhaltung", address]}
              meta="123.456 Anfragen"
              time="zuletzt heute, 11:29"
              action={{ label: "Adresse kopieren", icon: "copy", onClick: () => undefined }}
            />
            <Row icon="webhook" lines={["Stripe Zahlungen", hyphened]} time="heute, 11:26" marks={<Chip status="ok">POST</Chip>} />
            <Row
              icon="webhook"
              lines={[
                "Protokoll",
                <a class="k2-link" href="#protokoll">
                  Letzte Anfragen öffnen
                </a>,
              ]}
              time="heute, 11:20"
            />
          </List>
        </Pane>
      </Workspace>
    ),
    root,
  );
else if (scenario === "table" || scenario === "head" || scenario === "headmenu" || scenario === "headicon" || scenario === "headtwo")
  render(
    () => (
      <Workspace
        head={
          <Bar
            start={
              <Tabs
                label="Ansichten"
                items={[
                  { label: "Alle", current: true, onClick: () => undefined },
                  { label: "Ungelesen", onClick: () => undefined },
                ]}
              />
            }
            end={
              scenario === "head" ? (
                <>
                  <Input type="search" icon="search" label="Suchen" placeholder="Suchen" />
                  <Button variant="ghost" icon="adjustments-horizontal" label="Filter" />
                  <Button keep>Suche fokussieren</Button>
                  <Button keep disabled>
                    Gesperrt
                  </Button>
                </>
              ) : scenario === "headmenu" ? (
                <>
                  <Button keep pressed={marked()} onClick={() => setMarked(!marked())}>
                    Markiert
                  </Button>
                  <Menu label="Weitere Aktionen" items={[{ label: "Einstellungen", onClick: () => undefined }]} />
                </>
              ) : scenario === "headicon" ? (
                // a kept deed with words beside a kept icon button, and no "…" of the app's own
                <>
                  <Button keep>Freigeben</Button>
                  <Button keep icon="star" label="Favorit" />
                </>
              ) : scenario === "headtwo" ? (
                // two "…" of the app's own beside a kept deed: the first takes the deed, the second keeps its own
                <>
                  <Button keep>Freigeben</Button>
                  <Menu label="Weitere Aktionen" items={[{ label: "Einstellungen", onClick: () => undefined }]} />
                  <Menu icon="eye" label="Ansicht" items={[{ label: "Kompakt", onClick: () => undefined }]} />
                </>
              ) : undefined
            }
          />
        }
      >
        <Pane.Split>
          <Pane label="Spalte" width={{ min: 440, default: 720 }}>
            <Table
              label="Dateien"
              rows={files}
              rowKey={(file) => file.id}
              select={{ selected: picked(), onChange: setPicked, all: "Alle Dateien", row: (file) => file.name }}
              group={(file) => ({ key: file.kind, head: () => file.kind, count: "1" })}
              columns={[
                { title: "Name", cell: (file) => ({ lines: [file.name, file.detail] }), width: { min: 160, default: 320 } },
                { title: "Geändert", cell: (file) => file.changed, width: { min: 120, default: 160 } },
              ]}
              phone={(file) => ({
                lines: [file.name, file.detail],
                time: file.changed,
                marks: file.id === "f3" ? <Chip status="ok">POST</Chip> : undefined,
                // the row's deeds, which a column of deeds offers on the desktop
                end: <Menu label={`Aktionen für ${file.name}`} items={[{ label: "Umbenennen", onClick: () => undefined }]} />,
              })}
            />
          </Pane>
        </Pane.Split>
      </Workspace>
    ),
    root,
  );
else
  render(
    () => (
      <Workspace
        head={
          <Bar
            start={
              <Tabs
                label="Ansichten"
                items={views.map((label) => ({ label, current: current() === label, onClick: () => setCurrent(label) }))}
              />
            }
          />
        }
      >
        <Pane label="Spalte">
          <Notice tone="ai" title="Kurz gesagt">
            {note()}
          </Notice>
          <List label="Zeilen">
            <Row lines={["Absender", "Betreff", "Vorschau"]} time="09:12" marks={<Chip status="ok">12.345,67 €</Chip>} />
            <Row
              lines={[<Cut text="ab@nordwind-industrie-holding-gruppe.example.com" keep="domain" />, "Betreff", "Vorschau"]}
              time="09:13"
            />
          </List>
        </Pane>
      </Workspace>
    ),
    root,
  );
window.__k2Mounted = true;
