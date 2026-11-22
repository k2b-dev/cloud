/** Demo data: a small mailbox. Invented names and addresses. */
export type Mail = {
  id: string;
  folder: "inbox" | "drafts" | "sent" | "suppliers";
  from: string;
  address: string;
  color: string;
  subject: string;
  preview: string;
  body: string[];
  time: string;
  date: string;
  unread?: boolean;
  tag?: { label: string; tone?: "ok" | "warn" | "bad" | "app" };
  attachments?: { name: string; size: string }[];
  problem?: { title: string; text: string };
};

export const folders = [
  { id: "inbox", label: "Posteingang", icon: "inbox", count: 7 },
  { id: "drafts", label: "Entwürfe", icon: "draft", count: 2 },
  { id: "sent", label: "Gesendet", icon: "send" },
  { id: "suppliers", label: "Lieferanten", icon: "folder" },
] as const;

export const mails: Mail[] = [
  {
    id: "m1",
    folder: "inbox",
    from: "Holzwerk Brandt",
    address: "einkauf@holzwerk-brandt.example",
    color: "#0f766e",
    subject: "Angebot Eichenplatten – Liefertermin",
    preview: "Guten Tag Frau Solberg, die Platten können wir in KW 49 liefern, wenn die Bestellung bis Freitag bei uns ist.",
    body: [
      "Guten Tag Frau Solberg,",
      "die 14 Platten können wir in KW 49 liefern, wenn die Bestellung bis Freitag bei uns ist. Der Preis aus dem Angebot bleibt bis dahin gültig. Die Lieferung kommt auf zwei Paletten, bitte halten Sie die Einfahrt frei.",
      "Freundliche Grüße\nHenrik Brandt",
    ],
    time: "09:42",
    date: "heute, 09:42",
    unread: true,
    tag: { label: "Angebot", tone: "ok" },
    attachments: [
      { name: "Angebot-4471.pdf", size: "212 KB" },
      { name: "Lieferbedingungen.pdf", size: "96 KB" },
    ],
  },
  {
    id: "m2",
    folder: "inbox",
    from: "Jonas Hartwig",
    address: "jonas.hartwig@example.org",
    color: "#7c3aed",
    subject: "Frage zur Rechnung 2026-1184",
    preview: "Hallo, auf der Rechnung steht ein anderer Betrag als im Auftrag. Können Sie das bitte prüfen?",
    body: ["Hallo,", "auf der Rechnung steht ein anderer Betrag als im Auftrag. Können Sie das bitte prüfen?", "Viele Grüße\nJonas Hartwig"],
    time: "09:15",
    date: "heute, 09:15",
    unread: true,
    tag: { label: "Rechnung", tone: "warn" },
  },
  {
    id: "m3",
    folder: "inbox",
    from: "Stadtwerke Auental",
    address: "service@stadtwerke-auental.example",
    color: "#2563eb",
    subject: "Zählerwechsel am 02.12.",
    preview: "Sehr geehrte Damen und Herren, wir tauschen an diesem Tag den Stromzähler in Ihrer Werkstatt.",
    body: ["Sehr geehrte Damen und Herren,", "wir tauschen am 02.12. zwischen 8 und 12 Uhr den Stromzähler in Ihrer Werkstatt. Bitte sorgen Sie für Zugang zum Zählerschrank."],
    time: "08:50",
    date: "heute, 08:50",
    unread: true,
  },
  {
    id: "m4",
    folder: "inbox",
    from: "Petra Lindqvist",
    address: "petra@lindqvist.example",
    color: "#b45309",
    subject: "Küche Maß nehmen – Terminvorschlag",
    preview: "Dienstag oder Donnerstag ab 16 Uhr würde bei uns passen. Sagen Sie mir einfach, was Ihnen lieber ist.",
    body: ["Hallo,", "Dienstag oder Donnerstag ab 16 Uhr würde bei uns passen. Sagen Sie mir einfach, was Ihnen lieber ist.", "Petra Lindqvist"],
    time: "gestern",
    date: "gestern, 17:20",
  },
  {
    id: "m5",
    folder: "inbox",
    from: "Lackfabrik Nordhaus",
    address: "vertrieb@lackfabrik-nordhaus.example",
    color: "#be123c",
    subject: "Preisliste 2027",
    preview: "Anbei erhalten Sie unsere neue Preisliste, gültig ab 1. Januar 2027.",
    body: ["Sehr geehrte Kundin, sehr geehrter Kunde,", "anbei erhalten Sie unsere neue Preisliste, gültig ab 1. Januar 2027."],
    time: "gestern",
    date: "gestern, 11:02",
    unread: true,
    attachments: [{ name: "Preisliste-2027.pdf", size: "1,4 MB" }],
  },
  {
    id: "m6",
    folder: "inbox",
    from: "Architekturbüro Winter",
    address: "post@winter-architektur.example",
    color: "#4338ca",
    subject: "Re: Treppe Haus am Hang",
    preview: "Danke für die Zeichnung. Wir brauchen noch die Höhe der Stufen am oberen Absatz.",
    body: ["Hallo Frau Solberg,", "danke für die Zeichnung. Wir brauchen noch die Höhe der Stufen am oberen Absatz."],
    time: "Mi.",
    date: "Mittwoch, 15:31",
    problem: { title: "Antwort nicht zugestellt", text: "Der Server von winter-architektur.example hat die Antwort vom 19.11. abgelehnt." },
  },
  {
    id: "m7",
    folder: "inbox",
    from: "Bauhof Nordtal",
    address: "bauhof@nordtal.example",
    color: "#15803d",
    subject: "Abholung Altholz",
    preview: "Der Container steht ab Montag bereit, Abholung nach Anruf.",
    body: ["Der Container steht ab Montag bereit, Abholung nach Anruf."],
    time: "Mi.",
    date: "Mittwoch, 10:12",
  },
  {
    id: "m8",
    folder: "inbox",
    from: "Familie Oswald",
    address: "oswald@example.net",
    color: "#a21caf",
    subject: "Erinnerung: offenes Angebot Einbauschrank",
    preview: "Das Angebot vom 02.11. läuft am 30.11. aus. Sollen wir es verlängern?",
    body: ["Guten Tag,", "das Angebot vom 02.11. läuft am 30.11. aus. Sollen wir es verlängern?"],
    time: "Di.",
    date: "Dienstag, 18:40",
    tag: { label: "Angebot", tone: "ok" },
  },
  {
    id: "m9",
    folder: "inbox",
    from: "Karla Oswald",
    address: "karla.oswald@example.net",
    color: "#0e7490",
    subject: "Bewerbung um einen Ausbildungsplatz",
    preview: "Sehr geehrte Frau Renz, hiermit bewerbe ich mich um einen Ausbildungsplatz als Tischlerin.",
    body: ["Sehr geehrte Frau Renz,", "hiermit bewerbe ich mich um einen Ausbildungsplatz als Tischlerin."],
    time: "Mo.",
    date: "Montag, 09:05",
    tag: { label: "Personal", tone: "app" },
  },
  {
    id: "m10",
    folder: "inbox",
    from: "Spedition Falk",
    address: "dispo@spedition-falk.example",
    color: "#52525b",
    subject: "Lieferavis 4471",
    preview: "Ihre Sendung wird am 23.11. zwischen 7 und 11 Uhr zugestellt.",
    body: ["Ihre Sendung wird am 23.11. zwischen 7 und 11 Uhr zugestellt."],
    time: "Mo.",
    date: "Montag, 07:44",
  },
  {
    id: "m11",
    folder: "inbox",
    from: "Tischlerinnung Auental",
    address: "info@tischlerinnung.example",
    color: "#9a3412",
    subject: "Einladung zur Mitgliederversammlung",
    preview: "Wir laden Sie herzlich zur Mitgliederversammlung am 05.12. ein.",
    body: ["Wir laden Sie herzlich zur Mitgliederversammlung am 05.12. ein."],
    time: "Fr.",
    date: "Freitag, 12:00",
  },
  {
    id: "m12",
    folder: "drafts",
    from: "Mira Solberg",
    address: "mira@solberg-kramer.example",
    color: "#2563eb",
    subject: "Antwort: Treppe Haus am Hang",
    preview: "Die Stufenhöhe am oberen Absatz beträgt 17,5 cm …",
    body: ["Die Stufenhöhe am oberen Absatz beträgt 17,5 cm …"],
    time: "Mi.",
    date: "Mittwoch, 16:02",
  },
];

export const contacts = [
  { value: "einkauf@holzwerk-brandt.example", label: "Holzwerk Brandt", hint: "Lieferant" },
  { value: "jonas.hartwig@example.org", label: "Jonas Hartwig", hint: "Kunde" },
  { value: "petra@lindqvist.example", label: "Petra Lindqvist", hint: "Kundin" },
  { value: "post@winter-architektur.example", label: "Architekturbüro Winter", hint: "Partner" },
  { value: "dispo@spedition-falk.example", label: "Spedition Falk", hint: "Lieferant" },
  { value: "karla.oswald@example.net", label: "Karla Oswald", hint: "Bewerberin" },
  { value: "vertrieb@lackfabrik-nordhaus.example", label: "Lackfabrik Nordhaus", hint: "Lieferant" },
];
