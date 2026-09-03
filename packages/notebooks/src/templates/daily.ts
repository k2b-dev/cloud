import { dailyNotesDe } from "./daily.de";
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
- Mark tasks and habits as you complete them.
`;
};

export const dailyNotesTemplate: NotebookTemplate = {
  id: "daily-notes",
  name: "Daily Journal",
  description: "Daily notes, inbox triage, habits, tasks, and weekly reviews.",
  icon: "ti ti-calendar-stats",
  notebookName: "Daily Journal",
  notebookDescription: "Daily notes, an inbox, and automatic page lists with mood, energy, and sleep.",
  translations: {
    de: {
      name: "Tagebuch",
      description: "Tägliche Notizen, Posteingang, Gewohnheiten, Aufgaben und Wochenrückblicke.",
      notebookName: "Tagebuch",
      notebookDescription: "Tägliche Notizen, Posteingang und automatische Seitenlisten mit Stimmung, Energie und Schlaf.",
    },
  },
  homepageNoteKey: "home",
  notes: (ctx: TemplateContext) => {
    if (ctx.locale?.toLowerCase().split("-")[0] === "de") return dailyNotesDe(ctx);
    const today = ctx.now;
    const yesterday = shiftDays(ctx.now, -1);
    const year = today.getFullYear();
    const month = monthTitle(today);
    return [
      {
        key: "home",
        content: (c) => `# Daily Journal

:::success
Start here. Write a short daily note and browse your mood, energy, and sleep in the page list below.
:::

## How to use this notebook

1. Open ${c.link("day.today", "today's note")}. For another day, add a note under its month and copy the daily structure.
2. Fill the mood data and check off habits or tasks in the day note.
3. Put loose thoughts in ${c.link("inbox", "Inbox")}. Review them when they become useful.
4. Write a short weekly review below: what helped, what changed, and what to try next.

:::info
Create year and month pages as needed. Their queries list tagged child pages; keep daily pages under the matching month.
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
## Review

- Review your daily notes and record one lesson for next week.
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
- [ ] Plan two meals from the pantry

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

## Monthly focus

- Wins:
- Lessons:
- Carry forward:

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
