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

const dailyYearScriptDe = `// Diese Seite wertet #month- und #daily-Notizen aus.
const year = Number(current.data("year")?.value.year ?? current.title);

const monthNotes = (await nb.search("#month"))
  .filter((note) => Number(note.data("month")?.value.year) === year)
  .sort((a, b) => Number(a.data("month")?.value.month ?? 0) - Number(b.data("month")?.value.month ?? 0));

const dailyNotes = (await nb.search("#daily")).filter((note) => String(note.data("mood")?.value.date ?? "").startsWith(String(year) + "-"));

ui.render(
  ui.heading("Monate", 2),
  ui.table(monthNotes.map((note) => {
    const month = String(note.data("month")?.value.month ?? "").padStart(2, "0");
    return {
      Monat: note,
      Tage: dailyNotes.filter((day) => String(day.data("mood")?.value.date ?? "").startsWith(String(year) + "-" + month + "-")).length,
    };
  }), { emptyText: "Noch keine Monatsnotizen vorhanden." }),
);`;

const dailyMonthScriptDe = `// Diese Seite wertet die täglichen Notizen dieses Monats aus.
const pad2 = (value) => String(value).padStart(2, "0");
const meta = current.data("month")?.value ?? {};
const year = Number(meta.year ?? new Date().getFullYear());
const month = Number(meta.month ?? new Date().getMonth() + 1);
const prefix = String(year) + "-" + pad2(month) + "-";

const days = (await nb.search("#daily"))
  .filter((note) => String(note.data("mood")?.value.date ?? note.title).startsWith(prefix))
  .sort((a, b) => a.title.localeCompare(b.title));

ui.render(
  ui.heading("Tage", 2),
  ui.table(days.map((note) => {
    const mood = note.data("mood")?.value ?? {};
    return {
      Tag: note,
      Stimmung: mood.mood ?? "",
      Energie: mood.energy ?? "",
      Gewohnheiten: note.todo("habits")?.items ?? [],
      Aufgaben: note.todo("tasks")?.items ?? [],
    };
  }), { emptyText: "Für diesen Monat sind noch keine täglichen Notizen vorhanden." }),
);`;

const dailyDashboardScriptDe = `// Tagebuchübersicht
// Liest #daily- und #inbox-Notizen und legt fehlende Jahres-, Monats- und Tagesseiten an.

const pad2 = (value) => String(value).padStart(2, "0");
const monthNames = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const localDate = (date) => date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
const monthTitle = (date) => pad2(date.getMonth() + 1) + " " + monthNames[date.getMonth()];

const yearScript = String.raw\`
${dailyYearScriptDe}
\`.trim();

const monthScript = String.raw\`
${dailyMonthScriptDe}
\`.trim();

const lines = (...items) => items.flat().join("\\n");
const scriptBlock = (source) => ["\`\`\`script", source.trim(), "\`\`\`"];

const yearStarter = (date) => [
  "# " + date.getFullYear(), "", "#year", "", "@year", ":::data",
  "year: " + date.getFullYear(), ":::", "", ...scriptBlock(yearScript),
].join("\\n");

const monthStarter = (date) => [
  "# " + monthTitle(date), "", "#month", "", "@month", ":::data",
  "year: " + date.getFullYear(), "month: " + (date.getMonth() + 1), ":::", "",
  "## Monatlicher Schwerpunkt", "", "- Erfolge:", "- Erkenntnisse:", "- Mitnehmen:", "",
  ...scriptBlock(monthScript),
].join("\\n");

const dayStarter = (date) => [
  "# " + localDate(date), "", "#daily #journal", "", "@mood", ":::data",
  "date: " + localDate(date), "mood: 4", "energy: 3", "sleep: 7", ":::", "",
  "@habits", "- [ ] Morgenspaziergang", "- [ ] Konzentriert arbeiten", "- [ ] 20 Minuten lesen", "",
  "@tasks", "- [ ] Eine Priorität festlegen", "- [ ] Eingang bearbeiten", "- [ ] Tagesabschluss notieren", "",
  "@notes", "## Notizen", "", "- Kurze Notizen hier ergänzen",
].join("\\n");

let allNotes = await nb.list();
const remember = (note) => {
  allNotes = allNotes.filter((item) => item.id !== note.id).concat(note);
  return note;
};
const findNote = (title, parentId) => allNotes.find((note) => note.title === title && note.parentId === parentId);
const ensureNote = async (title, parent, content) => {
  const parentId = parent?.id ?? null;
  const existing = findNote(title, parentId);
  if (existing) return existing;
  return remember(await nb.create({ parentId: parent?.id, content }));
};

const dailyNotes = (await nb.search("#daily")).sort((a, b) => a.title.localeCompare(b.title));
const latest = dailyNotes.slice(-7);
const inboxNote = (await nb.search("#inbox"))[0];
const inboxItems = inboxNote?.todo("inbox")?.items ?? [];
const openInbox = inboxItems.filter((item) => !item.done);
const openNote = (note) => {
  window.location.href = "/app/notebooks/" + current.notebook.id + "/notes/" + note.id;
};

const rows = latest.map((note) => {
  const mood = note.data("mood")?.value ?? {};
  return {
    Tag: note,
    Stimmung: mood.mood ?? "",
    Energie: mood.energy ?? "",
    Schlaf: mood.sleep ?? "",
    Gewohnheiten: note.todo("habits")?.items ?? [],
    Aufgaben: note.todo("tasks")?.items ?? [],
    Aktion: ui.button("Öffnen", () => openNote(note), { variant: "secondary", icon: "ti ti-arrow-right" }),
  };
});

ui.render(
  ui.heading("Tagesübersicht", 2),
  ui.row(
    ui.metric("Tägliche Notizen", dailyNotes.length, { icon: "ti ti-notebook", tone: "info" }),
    ui.metric("Offener Eingang", openInbox.length, { icon: "ti ti-inbox", tone: "warning" }),
    ui.metric("Letzte Tage", latest.length, { icon: "ti ti-calendar-stats", tone: "success" }),
  ),
  ui.table(rows, { emptyText: "Noch keine täglichen Notizen vorhanden." }),
  ui.chart("bar", {
    data: latest.map((note) => {
      const mood = note.data("mood")?.value ?? {};
      return { label: note.title.slice(5), value: Number(mood.energy ?? 0) };
    }),
    title: "Energie der letzten Tage",
    showValues: true,
    height: 180,
  }),
  ui.table(inboxItems.map((item) => ({ Eintrag: item.content, Status: item.done ? "erledigt" : "offen" })), {
    emptyText: "Der Eingang ist leer.",
  }),
  ui.button("Heutige Notiz öffnen", async () => {
    const now = new Date();
    const year = await ensureNote(String(now.getFullYear()), null, yearStarter(now));
    const month = await ensureNote(monthTitle(now), year, monthStarter(now));
    const day = await ensureNote(localDate(now), month, dayStarter(now));
    openNote(day);
  }, { variant: "primary", icon: "ti ti-calendar-plus" }),
  ui.button("Wochenrückblick erstellen", async () => {
    const tasks = latest.flatMap((note) => note.todo("tasks")?.items ?? []);
    const doneTasks = tasks.filter((item) => item.done).length;
    const openTasks = tasks.filter((item) => !item.done).length;
    const avgEnergy = latest.length
      ? Math.round(latest.reduce((sum, note) => sum + Number(note.data("mood")?.value.energy ?? 0), 0) / latest.length)
      : 0;
    const reviewText = lines(
      "", "## Rückblick " + new Date().toISOString().slice(0, 10), "",
      "- Geprüfte Notizen: " + latest.length,
      "- Erledigte Aufgaben: " + doneTasks,
      "- Offene Aufgaben: " + openTasks,
      "- Durchschnittliche Energie: " + avgEnergy,
      "- Mitnehmen: " + openInbox.slice(0, 3).map((item) => item.content).join("; "), "",
    );
    await current.section("review")?.append(reviewText);
    ui.toast("Rückblick unten eingefügt", { variant: "success" });
  }, { icon: "ti ti-clipboard-check" }),
);`;

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
- Markiere Aufgaben und Gewohnheiten; die Übersicht wertet sie automatisch aus.
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
Beginne hier. Schreibe täglich eine kurze Notiz, markiere Gewohnheiten und Aufgaben und lasse die Übersicht die letzten Tage zusammenfassen.
:::

## So verwendest du dieses Notizbuch

1. Wähle **Heutige Notiz öffnen**. Das Script legt fehlende Jahres-, Monats- und Tagesnotizen an.
2. Trage Stimmung und Energie ein und hake Gewohnheiten oder Aufgaben in der Tagesnotiz ab.
3. Halte lose Gedanken im ${c.link("inbox", "Eingang")} fest. Prüfe später, was davon weiterverfolgt werden soll.
4. Erstelle nach einigen Tagen einen **Wochenrückblick**. Die Zusammenfassung wird unten ergänzt.

:::info
Jahres- und Monatsübersichten müssen nicht von Hand gepflegt werden. Sie erstellen ihre Tabellen aus den Tagesnotizen.
:::

\`\`\`script
${dailyDashboardScriptDe}
\`\`\`

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
- [ ] Den Vorratsabgleich der Rezeptsammlung als wiederverwendbare Script-Idee festhalten

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

\`\`\`script
${dailyYearScriptDe}
\`\`\`
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

\`\`\`script
${dailyMonthScriptDe}
\`\`\`
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
