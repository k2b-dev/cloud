# Template: weekly report

Weekly report in personal Code: every Monday at 08:00 Berlin time, read the open and overdue tasks of one Space, let AI write a short report and deliver it to the owner's Gustav chat. Delivery is automatic; AI use needs a Cloud administrator's approval of the version by default.

Owner: personal Code. Copy it into `code.ts`, replace the fictional IDs and names, then check, test and submit as usual.

<!-- check: personal -->
```ts
import { app, core, spaces } from "@sdk";

// Fictional IDs: discover the Space with spaces.space.list and the chat with core.ai.chats.search.
const SPACE_ID = "Spc001";
const CHAT_ID = "Chat23";

app.schedule(
  { cron: "0 8 * * 1", timeZone: "Europe/Berlin", name: "weekly-report" },
  async () => {
    const open = await spaces.app().task.list({ spaceId: SPACE_ID, status: "active", sort: "deadline", limit: 50 });
    const overdue = await spaces.app().task.list({ spaceId: SPACE_ID, status: "active", deadlineFilter: "overdue", limit: 50 });
    const unassigned = open.filter(task => task.assigneeCount === 0);
    const facts = {
      open: open.length >= 50 ? "50 or more" : open.length,
      overdue: overdue.map(task => task.title).slice(0, 20),
      unassigned: unassigned.map(task => task.title).slice(0, 20),
    };

    let text = `Open tasks: ${facts.open}. Overdue: ${overdue.length}. Unassigned: ${unassigned.length}.`;
    if (overdue.length || unassigned.length) {
      const report = await core.app().ai.generate({
        task: "weekly.report",
        prompt:
          "Write a short weekly report in German for the owner of these tasks: one sentence on the overall state, " +
          "then a list of the overdue and unassigned tasks. Use only the given facts.",
        input: facts,
        model: { class: "fast" },
        output: { type: "text", maxChars: 3000 },
      });
      if (typeof report.output === "string" && report.output.trim()) text = report.output.trim();
    }

    const week = new Date().toISOString().slice(0, 10);
    await core.ai.chat(CHAT_ID).ai.chat.deliver({ text, idempotencyKey: `weekly-report:${week}` });
  },
  { name: "weekly-report", title: "Weekly report" },
);

export default app;
```
