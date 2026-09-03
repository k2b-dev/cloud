import type { TemplateContext, TemplateNote } from "./types";

const monthNames = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

const pad2 = (value: number) => String(value).padStart(2, "0");
const localDate = (date: Date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
const monthTitle = (date: Date) => `${pad2(date.getMonth() + 1)} ${monthNames[date.getMonth()]}`;

const shiftDays = (date: Date, days: number) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

const dayContentDe = (date: Date, mood: number, energy: number, sleep: number, doneHabits: number, doneTasks: number) => {
  const habits = ["Morgenspaziergang", "Konzentriert arbeiten", "20 Minuten lesen"];
  const tasks = ["Eine Priorität festlegen", "Eingang bearbeiten", "Tagesabschluss notieren"];
  return `# ${localDate(date)}

#daily #journal

@mood
:::data
date: ${localDate(date)}
mood: ${mood}
energy: ${energy}
sleep: ${sleep}
:::

@habits
${habits.map((item, index) => `- [${index < doneHabits ? "x" : " "}] ${item}`).join("\n")}

@tasks
${tasks.map((item, index) => `- [${index < doneTasks ? "x" : " "}] ${item}`).join("\n")}

@notes
## Notizen

- Halte die Notiz kurz genug, um sie jeden Tag zu schreiben.
- Hake Aufgaben und Gewohnheiten ab, sobald sie erledigt sind.
`;
};

export const dailyNotesDe = (ctx: TemplateContext): TemplateNote[] => {
  const today = ctx.now;
  const yesterday = shiftDays(ctx.now, -1);
  const year = today.getFullYear();
  const month = monthTitle(today);

  return [
    {
      key: "home",
      content: (c) => `# Tagebuch

:::success
Beginne hier. Schreibe täglich eine kurze Notiz. Die Seitenliste zeigt Stimmung, Energie und Schlaf aus deinen Tagesnotizen.
:::

## So verwendest du dieses Notizbuch

1. Öffne ${c.link("day.today", "die heutige Notiz")}. Lege für weitere Tage eine Notiz unter dem passenden Monat an und kopiere den Tagesaufbau.
2. Trage Stimmung und Energie ein und hake Gewohnheiten oder Aufgaben in der Tagesnotiz ab.
3. Halte lose Gedanken im ${c.link("inbox", "Eingang")} fest. Prüfe später, was davon weiterverfolgt werden soll.
4. Schreibe unten einen kurzen Wochenrückblick: Was hat geholfen, was hat sich verändert und was möchtest du ausprobieren?

:::info
Lege Jahres- und Monatsseiten bei Bedarf an. Ihre Abfragen listen untergeordnete Seiten mit dem passenden Tag auf; Tagesnotizen gehören unter den jeweiligen Monat.
:::

:::query
source: notes
scope: notebook
where:
  - field: $tags
    op: contains
    value: daily
sort:
  field: $title
  direction: asc
columns:
  - $title
  - mood.mood
  - mood.energy
  - mood.sleep
limit: 25
:::

@review
## Rückblick

- Erstelle nach einigen Tagesnotizen einen Wochenrückblick.
`,
    },
    {
      key: "inbox",
      content: `# Eingang

#inbox

@inbox
- [ ] Ersatzhüllen für Notizbücher bestellen, bevor der Vorrat aufgebraucht ist
- [ ] Einen kurzen Gedanken zur heimischen Hecke im Garten notieren
- [x] Anna fragen, ob Freitag weiterhin für einen Kaffee passt
- [ ] Ein Buch über bewusstes Üben suchen
- [ ] Zwei Gerichte aus vorhandenen Vorräten planen

@triage
| Eintrag | Nächster Schritt | Status |
|---|---|---|
| Heimische Hecke | In das Gartentagebuch verschieben | nächste Durchsicht |
| Kaffee mit Anna | Kalender | geplant |
| Buch über bewusstes Üben | Recherchieren | ausstehend |

:::info
Einträge sollen schnell erfasst sein. Erst bei der Durchsicht wird entschieden, was erhalten bleibt.
:::
`,
    },
    {
      key: "year.current",
      content: `# ${year}

#year

@year
:::data
year: ${year}
:::

@yearFocus
:::data
health: beständiger Schlaf und regelmäßiges Gehen
work: weniger parallele Projekte
learning: Garten, Kochen und Wissenssysteme
relationships: aufmerksamere Kontakte
:::

## Jahresnotizen

- Halte die Struktur nützlich, nicht perfekt.
- Lege Monatsnotizen nur bei Bedarf an.

:::query
source: notes
scope: children
where:
  - field: $tags
    op: contains
    value: month
sort:
  field: $title
  direction: asc
limit: 25
:::
`,
      children: [
        {
          key: "month.current",
          content: `# ${month}

#month

@month
:::data
year: ${year}
month: ${today.getMonth() + 1}
:::

## Monatlicher Schwerpunkt

- Erfolge:
- Erkenntnisse:
- Mitnehmen:

:::query
source: notes
scope: children
where:
  - field: $tags
    op: contains
    value: daily
sort:
  field: $title
  direction: asc
columns:
  - $title
  - mood.mood
  - mood.energy
  - mood.sleep
limit: 25
:::
`,
          children: [
            { key: "day.yesterday", content: dayContentDe(yesterday, 4, 3, 7, 2, 2) },
            { key: "day.today", content: dayContentDe(today, 3, 4, 6.5, 1, 1) },
          ],
        },
      ],
    },
  ];
};
