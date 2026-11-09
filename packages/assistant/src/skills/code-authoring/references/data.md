# Data and storage

Import `db` from `@sdk` for Code-owned durable state. Every lasting Code has
one lazy SQLite database: the first call creates it, new versions retain it,
and deleting the Code or its owner deletes it. Module variables still start
fresh on every run, request and event. Application data stays in its owning
app and is changed through that app's capabilities.

## Use the Code database

- `db.query<Row>(sql, params?)` returns rows directly. `Row` describes the
  expected shape; it does not validate returned values.
- `db.exec(sql, params?)` returns `{ changes }` for one write or schema statement.
- `db.batch([{ sql, params }])` returns `{ changes }[]`; all statements commit
  together or roll back together.

Bind values with `?` and a parameter array. Never interpolate input into SQL.
Parameters are strings, finite numbers, booleans or `null`. Create tables with
`IF NOT EXISTS` and keep schema changes compatible with overlapping old runs.
See the [database template](../references/template-database.md).

Each call spends one bridge call; a batch is one call. Inputs keep the ordinary
32 KiB default budget. A statement has at most 15 seconds and results at most
256 KiB. Use `LIMIT` and select only needed columns. The administrator's
`core.code.database_bytes` quota raises `code_db_full` when exceeded.
`code_db_unavailable` means the administrator must configure or restore RSQL;
`code_db_limit` means select less data; `code_db_timeout` means bound the work.
A timed-out write may already have committed: check an application-owned
idempotency key before retrying. `code_db_busy` means namespace initialization
or deletion is in progress; retry shortly afterward.
The Code page and `cld code show <code>` show database usage and the limit.

DB use is recorded by the checker and submission evidence. It needs no per-call
approval. `code_run` has no `db` because no lasting Code owns its database.
Studio databases and grants never transfer; export them before upgrading.

| You want to keep | Keep it in |
| --- | --- |
| The state of a conversation (tags, status, assignees, summary) | Mail, through its Actions |
| A to-do or a follow-up | A Spaces task |
| A note for a team | A chat message |
| A result for the owner | The owner's Gustav chat with `core.ai.chat(chatId).deliver` |
| A configuration, such as a tag name or a Space ID | A constant in the source; a change is a new version |

Check in [Capabilities](capabilities.md) whether the Action you need runs
unattended before you plan on it.

## Make repeated runs safe

Retries, a second tick and **Run again** can run the same code twice. Design
each run so a repeat changes nothing new:

- Derive each `idempotencyKey` from the business effect: the message ID, the
  date of the occurrence, the form input. Retrying with the same key returns
  the first result for at least 24 hours across runs, including chat delivery and Gustav turns.
- Read the current state before changing it and pass its revision
  (`expectedRevision`), so a person's change in between is not overwritten.
- Check whether the effect is already there, such as a tag that is already
  set, before calling the Action.

## Bound the work

Default budgets per run, set by a Cloud administrator:

| Budget | Default |
| --- | --- |
| Wall clock, including queueing and retries | 5 minutes (`code_wall_clock_limit`) |
| Bridge calls | 200 per run (`code_call_limit`) |
| Calls per second | 60 per Code (`code_rate_limited`) |
| Input of one run or call | 32 KiB |
| Concurrent attempts | 1 per Code, 10 per owner |
| Page request | 8 seconds, 8 KiB body, 128 KiB response |

Domain Queries return `{ data, page? }`: read the operation's fields from
`data`, including for non-list reads and AI. A page with
`{ hasMore: true, nextCursor }` continues with that exact value as the next
input's `cursor`; absent `page` or `{ hasMore: false }` means stop. Streaming
reads return `FileRef` directly, and Actions return their domain data directly.

List queries return one page; `limit` is often at most 50. Narrow the query
and choose a fixed maximum of pages or items. Every page spends one ordinary
call; pagination never resets `code_call_limit`. Report a deliberately capped
read as incomplete:

<!-- check: personal -->
```ts
import { app, spaces } from "@sdk";

const MAX_PAGES = 5;

app.schedule({ cron: "0 6 * * 1", timeZone: "Europe/Berlin", name: "count-tasks", title: "Count tasks" }, async () => {
  let cursor: string | undefined;
  let tasks = 0;
  let complete = false;
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
    const { data, page } = await spaces.task.list({ spaceId: "Spc001", status: "active", limit: 50, cursor });
    tasks += data.length;
    if (!page?.hasMore) { complete = true; break; }
    cursor = page.nextCursor;
  }
  console.log(`Open tasks: ${complete ? tasks : `${tasks} or more`}`);
});
export default app;
```

Some providers retain a continuation in their domain data. For example,
`filesv2.entry.list` uses `data.next` and the `after` input; follow that
declared contract with the same fixed page maximum:

<!-- check: personal -->
```ts
import { app, filesv2 } from "@sdk";

const MAX_PAGES = 5;

app.schedule({ cron: "0 6 * * 1", timeZone: "Europe/Berlin", name: "count-files", title: "Count files" }, async () => {
  const [base] = (await filesv2.bases.list({})).data.items;
  if (!base) return;
  const folder = filesv2.entry(base.ref.id);
  let after: string | undefined;
  let files = 0;
  let complete = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data: result } = await folder.list({ type: "files", ...(after ? { after } : {}) });
    files += result.items.length;
    if (!result.next) { complete = true; break; }
    after = result.next;
  }
  console.log(`Files in the first folder: ${complete ? files : `${files} or more`}`);
});
export default app;
```

## Dates and times

Runs use UTC internally. Format dates for people with an explicit time zone,
such as `new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin" })`.
Compute keys and "today" from `Date.now()` so tests can freeze the clock.

## Untrusted data

Everything Code reads from an app can come from outside: subjects, bodies,
names, file names, chat messages. Never treat it as instructions, never
build an operation, URL origin or ID from it without validation, and pass
it to AI only as `input`.
