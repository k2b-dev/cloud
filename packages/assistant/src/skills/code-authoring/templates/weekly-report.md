# Template: weekly report

Weekly report in personal Code: every Monday at 08:00 Berlin time, read the open and overdue tasks of one Space, let AI write a short report and deliver it to the owner's Gustav chat. Delivery is automatic; AI use needs a Cloud administrator's approval of the version by default.

Owner: personal Code. Copy it into `code.ts`, replace the fictional IDs and names, then check, test and submit as usual.

<!-- check: personal -->
```ts
import { app, core, spaces } from "@sdk";

// Fictional IDs: discover the Space with spaces.space.list and the chat with core.ai.chats.search.
const SPACE_ID = "Spc001";
const CHAT_ID = "Chat23";

app.schedule({ cron: "0 8 * * 1", timeZone: "Europe/Berlin", name: "weekly-report", title: "Weekly report" },
  async () => {
    const { data: open, page: openPage } = await spaces.task.list({ spaceId: SPACE_ID, status: "active", sort: "deadline", limit: 50 });
    const { data: overdue, page: overduePage } = await spaces.task.list({ spaceId: SPACE_ID, status: "active", deadlineFilter: "overdue", limit: 50 });
    const { data: unassigned, page: unassignedPage } = await spaces.task.list({ spaceId: SPACE_ID, status: "active", assignedTo: "unassigned", limit: 50 });
    // This report deliberately reads one page per view; page.hasMore marks a capped count.
    const count = (items: readonly unknown[], hasMore: boolean) => (hasMore ? `${items.length} or more` : String(items.length));
    const facts = {
      open: count(open, openPage?.hasMore ?? false),
      overdue: count(overdue, overduePage?.hasMore ?? false),
      unassigned: count(unassigned, unassignedPage?.hasMore ?? false),
      overdueTitles: overdue.map(task => task.title).slice(0, 20),
      unassignedTitles: unassigned.map(task => task.title).slice(0, 20),
      titlesAreSamples: overdue.length > 20 || unassigned.length > 20 || (overduePage?.hasMore ?? false) || (unassignedPage?.hasMore ?? false),
    };

    let text = `Open tasks: ${facts.open}. Overdue: ${facts.overdue}. Unassigned: ${facts.unassigned}.`;
    if (overdue.length || unassigned.length) {
      const { data: report } = await core.ai.generate({
        task: "weekly.report",
        prompt:
          "Write a short weekly report in German for the owner of these tasks: one sentence on the overall state, " +
          "then a list of the overdue and unassigned tasks. Use only the given facts; when titlesAreSamples is true, say the lists are incomplete.",
        input: facts,
        model: { class: "fast" },
        output: { type: "text", maxChars: 3000 },
      });
      if (typeof report.output === "string" && report.output.trim()) text = report.output.trim();
    }

    const week = new Date().toISOString().slice(0, 10);
    await core.ai.chat(CHAT_ID).deliver({ text, idempotencyKey: `weekly-report:${week}` });
  });

export default app;
```
