# Template: Aufgabe morgen fällig → zuweisen und in den Team-Chat schreiben

Personal Code reacts to tasks created or changed in one Space. If a task is due
tomorrow and unassigned, it assigns the chosen person and posts a short note
in the team chat. Tasks already assigned to that person get the same note;
the chat's idempotency key prevents duplicates for that task and deadline.
Other assignees stay untouched.

There is no day-before event: `spaces.item.due` fires at the deadline. A daily
08:00 Berlin schedule also checks tasks when the calendar advances without
an edit. Events and the daily check use the same function. Change the time
zone and schedule together if your team uses another zone.

Owner: personal Code. Replace the fictional IDs with an authorized Space,
an assignable person's UUID and a team chat conversation. The executing
account needs read and write access to the Space and membership in the chat.
Resource-owned Code can use the same explicit place after sharing it with
its Code account. Check, test and submit; the person then activates the version.
Assignment and chat effects follow the installation's Code approval policy.

<!-- check: personal -->
```ts
import { app, spaces, chat } from "@sdk";

const SPACE = "Spc001";
const PERSON = "00000000-0000-4000-8000-000000000001";
const TEAM_CHAT = "Cnv001";
const ZONE = "Europe/Berlin";

function day(value: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(value);
}
function tomorrow() {
  // Advance the local calendar date, including days across a DST change.
  const today = day(new Date());
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
async function assignAndNotify(id: string) {
  const { data: task } = await spaces.item.read({ id });
  if (task.kind !== "task" || task.spaceId !== SPACE || task.completedAt || !task.deadline) return;
  if (task.relationsTruncated) throw new Error("Read the complete assignment before changing it");
  const due = task.deadline.length === 10 ? task.deadline : day(new Date(task.deadline));
  if (due !== tomorrow()) return;
  let assigned = false;
  for (const person of task.assignees) {
    if (person.id !== PERSON) return;
    assigned = true;
  }
  if (!assigned) {
    await spaces.space(SPACE).task.update({ itemId: task.id, addAssigneeIds: [PERSON] });
  }
  // Repeating after assignment is safe: the message keeps the same occurrence key.
  const title = task.title.replace(/[\r\n`]/g, " ").slice(0, 120);
  await chat.message.post({
    conversation: TEAM_CHAT,
    body: `Morgen fällig und zugewiesen: \`${title}\` (${task.id})`,
    idempotencyKey: `tomorrow:${task.id}:${due}`,
  });
}

app.on(spaces.space(SPACE), "spaces.item.created", async event => {
  await assignAndNotify(event.subject.id);
});
app.on(spaces.space(SPACE), "spaces.item.updated", async event => {
  await assignAndNotify(event.subject.id);
});
app.schedule({ cron: "0 8 * * *", timeZone: ZONE, name: "tomorrow-tasks", title: "Aufgaben für morgen zuweisen" }, async () => {
  let cursor: string | undefined;
  do {
    const { data: tasks, page } = await spaces.task.list({ spaceId: SPACE, status: "active", sort: "deadline", sortDesc: false, limit: 100, cursor });
    for (const task of tasks) await assignAndNotify(task.id);
    cursor = page?.hasMore ? page.nextCursor : undefined;
  } while (cursor);
});
export default app;
```

The daily run follows all pages within the existing run and capability-call
budgets. A large Space can exhaust them; Runs shows the failure. Review that
Space's size and operator limits before activating. A failure after an Action
is visible and needs deliberate recovery; it never automatically repeats effects.
