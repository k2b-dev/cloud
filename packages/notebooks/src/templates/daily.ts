import type { NotebookTemplate, TemplateContext } from "./types";

const monthNames = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const pad2 = (value: number) => String(value).padStart(2, "0");
const localDate = (date: Date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
const monthTitle = (date: Date) => `${pad2(date.getMonth() + 1)} ${monthNames[date.getMonth()]}`;

const shiftDays = (date: Date, days: number) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

const dailyYearScript = `// This page is an index. It reads #month and #daily notes.
const year = Number(current.data("year")?.value.year ?? current.title);

const monthNotes = (await nb.search("#month"))
  .filter((note) => Number(note.data("month")?.value.year) === year)
  .sort((a, b) => Number(a.data("month")?.value.month ?? 0) - Number(b.data("month")?.value.month ?? 0));

const dailyNotes = (await nb.search("#daily")).filter((note) => String(note.data("mood")?.value.date ?? "").startsWith(String(year) + "-"));

ui.render(
  ui.heading("Months", 2),
  ui.table(monthNotes.map((note) => {
    const month = String(note.data("month")?.value.month ?? "").padStart(2, "0");
    return {
      Month: note,
      Days: dailyNotes.filter((day) => String(day.data("mood")?.value.date ?? "").startsWith(String(year) + "-" + month + "-")).length,
    };
  }), { emptyText: "No month notes yet." }),
);`;

const dailyMonthScript = `// This page is an index. It reads daily notes for this month.
const pad2 = (value) => String(value).padStart(2, "0");
const meta = current.data("month")?.value ?? {};
const year = Number(meta.year ?? new Date().getFullYear());
const month = Number(meta.month ?? new Date().getMonth() + 1);
const prefix = String(year) + "-" + pad2(month) + "-";

const days = (await nb.search("#daily"))
  .filter((note) => String(note.data("mood")?.value.date ?? note.title).startsWith(prefix))
  .sort((a, b) => a.title.localeCompare(b.title));

ui.render(
  ui.heading("Days", 2),
  ui.table(days.map((note) => {
    const mood = note.data("mood")?.value ?? {};
    return {
      Day: note,
      Mood: mood.mood ?? "",
      Energy: mood.energy ?? "",
      Habits: note.todo("habits")?.items ?? [],
      Tasks: note.todo("tasks")?.items ?? [],
    };
  }), { emptyText: "No daily notes in this month yet." }),
);`;

const dailyDashboardScript = `// Daily Journal dashboard
// Reads #daily and #inbox notes, then creates missing year/month/day pages on demand.

// ── Date helpers ────────────────────────────────────────────────
const pad2 = (value) => String(value).padStart(2, "0");
const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const localDate = (date) => date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
const monthTitle = (date) => pad2(date.getMonth() + 1) + " " + monthNames[date.getMonth()];

// ── Scripts copied into generated year/month pages ──────────────
const yearScript = String.raw\`
${dailyYearScript}
\`.trim();

const monthScript = String.raw\`
${dailyMonthScript}
\`.trim();

// ── Markdown builders for generated pages ───────────────────────
const lines = (...items) => items.flat().join("\\n");
const scriptBlock = (source) => ["\`\`\`script", source.trim(), "\`\`\`"];

const yearStarter = (date) => [
  "# " + date.getFullYear(),
  "",
  "#year",
  "",
  "@year",
  ":::data",
  "year: " + date.getFullYear(),
  ":::",
  "",
  ...scriptBlock(yearScript),
].join("\\n");

const monthStarter = (date) => [
  "# " + monthTitle(date),
  "",
  "#month",
  "",
  "@month",
  ":::data",
  "year: " + date.getFullYear(),
  "month: " + (date.getMonth() + 1),
  ":::",
  "",
  "## Monthly focus",
  "",
  "- Wins:",
  "- Lessons:",
  "- Carry forward:",
  "",
  ...scriptBlock(monthScript),
].join("\\n");

const dayStarter = (date) => [
  "# " + localDate(date),
  "",
  "#daily #journal",
  "",
  "@mood",
  ":::data",
  "date: " + localDate(date),
  "mood: 4",
  "energy: 3",
  "sleep: 7",
  ":::",
  "",
  "@habits",
  "- [ ] Morning walk",
  "- [ ] Deep work block",
  "- [ ] Read for 20 minutes",
  "",
  "@tasks",
  "- [ ] Pick one priority",
  "- [ ] Process captures",
  "- [ ] Write shutdown note",
  "",
  "@notes",
  "## Notes",
  "",
  "- Add short notes here",
].join("\\n");

// ── Note creation helpers ───────────────────────────────────────
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

// ── Read notebook data ──────────────────────────────────────────
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
    Day: note,
    Mood: mood.mood ?? "",
    Energy: mood.energy ?? "",
    Sleep: mood.sleep ?? "",
    Habits: note.todo("habits")?.items ?? [],
    Tasks: note.todo("tasks")?.items ?? [],
    Action: ui.button("Open", () => openNote(note), { variant: "secondary", icon: "ti ti-arrow-right" }),
  };
});

// ── Render dashboard ────────────────────────────────────────────
ui.render(
  ui.heading("Daily dashboard", 2),
  ui.row(
    ui.metric("Daily notes", dailyNotes.length, { icon: "ti ti-notebook", tone: "info" }),
    ui.metric("Open inbox", openInbox.length, { icon: "ti ti-inbox", tone: "warning" }),
    ui.metric("Latest days", latest.length, { icon: "ti ti-calendar-stats", tone: "success" }),
  ),
  ui.table(rows, { emptyText: "No daily notes yet." }),
  ui.chart("bar", {
    data: latest.map((note) => {
      const mood = note.data("mood")?.value ?? {};
      return { label: note.title.slice(5), value: Number(mood.energy ?? 0) };
    }),
    title: "Energy in latest daily notes",
    showValues: true,
    height: 180,
  }),
  ui.table(inboxItems.map((item) => ({ Capture: item.content, Done: item.done ? "yes" : "open" })), {
    emptyText: "Inbox is clear.",
  }),

  ui.button("Open today's note", async () => {
    const now = new Date();
    const year = await ensureNote(String(now.getFullYear()), null, yearStarter(now));
    const month = await ensureNote(monthTitle(now), year, monthStarter(now));
    const day = await ensureNote(localDate(now), month, dayStarter(now));
    openNote(day);
  }, { variant: "primary", icon: "ti ti-calendar-plus" }),

  ui.button("Make weekly review", async () => {
    const tasks = latest.flatMap((note) => note.todo("tasks")?.items ?? []);
    const doneTasks = tasks.filter((item) => item.done).length;
    const openTasks = tasks.filter((item) => !item.done).length;
    const avgEnergy = latest.length
      ? Math.round(latest.reduce((sum, note) => sum + Number(note.data("mood")?.value.energy ?? 0), 0) / latest.length)
      : 0;
    const reviewText = lines(
      "",
      "## Review " + new Date().toISOString().slice(0, 10),
      "",
      "- Notes reviewed: " + latest.length,
      "- Done tasks: " + doneTasks,
      "- Open tasks: " + openTasks,
      "- Average energy: " + avgEnergy,
      "- Carry forward: " + openInbox.slice(0, 3).map((item) => item.content).join("; "),
      "",
    );
    await current.section("review")?.append(reviewText);
    ui.toast("Review added below", { variant: "success" });
  }, { icon: "ti ti-clipboard-check" }),
);`;

const dayContent = (date: Date, mood: number, energy: number, sleep: number, doneHabits: number, doneTasks: number) => {
  const habits = ["Morning walk", "Deep work block", "Read for 20 minutes"];
  const tasks = ["Pick one priority", "Process captures", "Write shutdown note"];
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
## Notes

- Keep the note short enough to write every day.
- Mark tasks and habits; the dashboard reads them automatically.
`;
};

export const dailyNotesTemplate: NotebookTemplate = {
  id: "daily-notes",
  name: "Daily Journal",
  description: "Daily notes, inbox triage, habits, tasks, and weekly reviews.",
  icon: "ti ti-calendar-stats",
  notebookName: "Daily Journal",
  notebookDescription: "Daily notes, inbox, and a script dashboard that reads real mood, habits, and tasks.",
  scriptsEnabled: true,
  homepageNoteKey: "home",
  notes: (ctx: TemplateContext) => {
    const today = ctx.now;
    const yesterday = shiftDays(ctx.now, -1);
    const year = today.getFullYear();
    const month = monthTitle(today);
    return [
      {
        key: "home",
        content: (c) => `# Daily Journal

:::success
Start here. Write one small daily note, mark habits and tasks, and let the dashboard summarize the last days.
:::

## How to use this notebook

1. Click **Open today's note**. The script creates the year, month, and day notes if they are missing.
2. Fill the mood data and check off habits or tasks in the day note.
3. Put loose thoughts in ${c.link("inbox", "Inbox")}. Review them when they become useful.
4. Use **Make weekly review** after a few days. It appends a short summary below.

:::info
You do not maintain month or year indexes by hand. Those pages generate their tables from daily note data.
:::

\`\`\`script
${dailyDashboardScript}
\`\`\`

@review
## Review

- Use the weekly review button after a few daily notes.
`,
      },
      {
        key: "inbox",
        content: `# Inbox

#inbox

@inbox
- [ ] Order replacement notebook sleeves before the current batch runs out
- [ ] Draft a short note about the native hedge idea for the garden
- [x] Ask Anna whether Friday still works for coffee
- [ ] Look up one book on deliberate practice
- [ ] Turn the recipe pantry matcher into a reusable script idea

@triage
| Capture | Action | Status |
|---|---|---|
| Native hedge idea | Move to garden planner | next review |
| Coffee with Anna | Calendar | scheduled |
| Deliberate practice book | Research | waiting |

:::info
Inbox entries should be cheap. Review decides what survives.
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
health: steady sleep and walking
work: fewer active projects
learning: gardens, cooking, knowledge systems
relationships: warmer check-ins
:::

## Year notes

- Keep the structure useful, not perfect.
- Add month notes only when you need them.

\`\`\`script
${dailyYearScript}
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

## Monthly focus

- Wins:
- Lessons:
- Carry forward:

\`\`\`script
${dailyMonthScript}
\`\`\`
`,
            children: [
              {
                key: "day.yesterday",
                content: dayContent(yesterday, 4, 3, 7, 2, 2),
              },
              {
                key: "day.today",
                content: dayContent(today, 3, 4, 6.5, 1, 1),
              },
            ],
          },
        ],
      },
    ];
  },
};
