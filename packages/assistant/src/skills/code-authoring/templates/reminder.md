# Template: reminder with a number

Personal Code that posts a supplied number and its timestamp. Gustav confirms
it in one sentence. This still starts a model turn with the chat's history;
it is not a free or silent delivery. Discover the fictional Space and chat IDs
through the SDK before adapting the example. Check, test and submit as usual.

<!-- check: personal -->
```ts
import { app, core, spaces } from "@sdk";

app.schedule({ cron: "0 8 * * *", timeZone: "Europe/Berlin", name: "reminder", title: "Task reminder" },
  async ({ runId, scheduledAt }) => {
    const { data, page } = await spaces.task.list({ spaceId: "Spc001", status: "active", limit: 50 });
    const occurrence = scheduledAt ?? runId;
    await core.ai.chat("Chat23").send({
      text: "Confirm the supplied active-task count and timestamp in one sentence. If moreAvailable is true, describe it as a lower bound. Do not recalculate, compare earlier values, or use tools.",
      context: JSON.stringify({ count: data.length, moreAvailable: page?.hasMore ?? false, at: scheduledAt ?? new Date().toISOString() }),
      idempotencyKey: `task-reminder:${occurrence}`,
    });
  });
export default app;
```

Keep `text` fixed. Put amounts, times, event values and query results in
`context`, even when they look harmless. For a different reminder, replace
the fixed instruction and the data query together. A retried occurrence keeps
its key and payload; a changed payload needs a new intended occurrence.
