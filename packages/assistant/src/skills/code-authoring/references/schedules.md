# Schedules

`app.schedule(when, handler, options?)` registers a timed automation. Declare
it at module level with constant values; the checker records the timing in
the version. A changed time needs a new version that the person switches on.
Resource and personal Code need at least one schedule or route
(`code_no_entrypoint`).

## Recurring local time

Pass a five-field cron expression and an IANA time zone. Ask for the time
zone or take it from the routine you rebuild; never guess the machine's zone.

<!-- check: personal -->
```ts
import { app, spaces } from "@sdk";

// Fictional Space ID; read the real one with spaces.space.list.
const team = spaces.space("Spc001");

app.schedule({ cron: "0 9 * * 1", timeZone: "Europe/Berlin", name: "weekly-review" }, async () => {
  const day = new Date().toISOString().slice(0, 10);
  await team.task.create({
    title: `Weekly review ${day}`,
    priority: "medium",
    idempotencyKey: `weekly-review:${day}`,
  });
}, { name: "weekly-review", title: "Weekly review" });
export default app;
```

- A string such as `app.schedule("0 9 * * 1", …)` or an object without
  `timeZone` runs in UTC.
- In spring a skipped local minute does not run; in autumn a repeated minute
  runs once, at its first occurrence.
- If the previous run of the same schedule is still queued or running, the
  tick is **Skipped, previous run is still running**.
- After Core downtime the latest missed tick still runs; older ticks do not.
- A paused Code creates no runs from ticks.

## Once at a chosen time

<!-- check: personal -->
```ts
import { app, core } from "@sdk";

app.schedule({ at: "2026-12-01T09:00:00+01:00", timeZone: "Europe/Berlin" }, async () => {
  // Fictional chat ID; discover the owner's chat first.
  await core.ai.chat("Chat23").ai.chat.deliver({
    text: "Reminder: the yearly report is due today.",
    idempotencyKey: "yearly-report-reminder",
  });
}, { name: "yearly-report-reminder", title: "Yearly report reminder" });
export default app;
```

`at` includes seconds and `Z` or a numeric UTC offset; `timeZone` sets how
Cloud displays it. Cloud runs it on its next recovery pass, normally within
five seconds, and can still run it after up to seven days of downtime. Older
dates do not run. A consumed date never runs again, also not after a restart
or a new version.

## Names and titles

`name` is the stable identity of the automation across versions: letters,
digits, `.`, `_` and `-`, starting with a letter or digit, unique in the
module. Put it into the first argument or into `options`; the first argument
wins. `title` (1–200 characters, one line of plain text) is what people see.
Without a name, entrypoints are `schedule:0`, `schedule:1`, … in registration
order; they change when you reorder, so always name schedules.

A person can also start a schedule by hand on the Code page or with
`cld code run`. Code cannot start itself. A manual start blocks an
overlapping tick of the same schedule.

## Keys for each occurrence

A tick can be retried; give each Action a key that names the occurrence,
such as `weekly-review:2026-11-09`, so a retry returns the first result
instead of creating a second task. Tests freeze `Date.now()` to the fixture's
`now`, so these keys are stable in [tests](testing.md).

## What fails

<!-- check: personal fails code_static_schedule -->
```ts
import { app } from "@sdk";

const hour = new Date().getHours();
// Timing must be a constant, not computed at run time.
app.schedule({ cron: `0 ${hour} * * *`, timeZone: "Europe/Berlin", name: "dynamic" }, async () => {});
export default app;
```
