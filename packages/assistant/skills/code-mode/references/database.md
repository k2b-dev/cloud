# Resource database

Use only the Studio methods and query grammar documented here. The backing
database service is an implementation detail, not an additional API. Do not
import its client, look up vendor methods, or infer support from a SQL engine.
If an operation is absent here, inspect the relevant Studio management tool
contract rather than calling the underlying service directly.

Resource managers can inspect tables and run SELECT in Studio's Advanced → SQL
console. Opening it never creates a database. Advanced → Manage database offers
a streamed SQLite backup and an explicit reset. A reset removes schema/data,
preserving source, publications and files/KV; the next connect creates an empty
database. All code versions use the same current database. Restoring source does
not restore data. Never propose a reset as a routine fix for a query error.

Use a database when the App needs structured records and SQL
analysis. A resource does not get a database automatically. Connect explicitly:

```ts
const db = await database.connect();
```

Connecting is idempotent and lazily creates this resource's database. The host
logs a successful connection. An unconfigured Cloud instance throws an error with
`error.code === "DB_NOT_CONFIGURED"`; explain that an administrator must
configure the Assistant database connection. Do not invent credentials or fall back to Kit settings.
`DB_AUTH_FAILED` means the stored server token was rejected; `DB_UNREACHABLE`
means the server could not be reached. Ask an administrator to check the
connection. For `DB_TIMEOUT`, a read can be retried once. For a write, inspect
its effects before retrying; a timeout does not prove that nothing changed.

The database belongs to the resource across edits, publications, and restores.
A fork starts without one. A one-off can use an existing resource database with
`code_run({ code, resourceId: "RESOURCE_SHORT_ID" })`; this requires Manage. Without
a resourceId, create an App only if the work needs its own durable database. Database calls always use the current user's permissions.

## Inspect data without a script

For a quick database check, load `code_sql` and call it directly with
`id`, `sql`, and optional `params`. No `code_run` or source write is necessary:

```json
{"id":"RESOURCE_ID","sql":"SELECT title FROM todos WHERE done = ? LIMIT 20","params":[false]}
```

The tool uses the same SELECT restrictions and current permissions as
`db.query()`. It never creates a database. Narrow the projection or LIMIT if the
result exceeds the tool response budget. Project-only access is available only
from the current authorized Project chat. The CLI equivalent is
`assistant code sql RESOURCE_ID --input-file query.json`.

## Read and write records

```ts
const { data: rows } = await db.query("SELECT title FROM todos WHERE done = ?", [false]);
const tables = await db.tables();
const todos = db.table("todos");
await todos.insert({ title: "Check totals", done: false });
```

`query(sql, params)` returns `{data: rows}` (an empty array for no matches) and
accepts bounded SELECT queries with positional parameters.
It rejects SQL writes, CTEs, comments, and internal database objects. Use
structured methods for mutations. Query results are bounded to 1,000 rows;
read the returned result shape and paginate structured row lists when needed.

| Call | Result |
| --- | --- |
| `db.tables()` | Array of table objects with `name` and `type` |
| `db.createTable(name, columns)` | `{created: name, type: "table"}`; requires Manage |
| `db.table(name).schema()` | Schema object with `name`, `type`, `columns` |
| `db.table(name).alter(changes)` | `{updated: true}`; requires Manage |
| `db.table(name).list(query?)` | `{data: Row[], meta?}`; see pagination below |
| `db.table(name).get(id)` | One row object; missing ID throws |
| `db.table(name).insert(rowOrRows)` | `{inserted: number}`; not the inserted row/ID |
| `db.table(name).update(id, values)` | `{updated: number}` |
| `db.table(name).delete(id)` | `null` on success |

All methods above return promises; `db.table(name)` itself returns a synchronous
handle. Errors throw with `error.code`; there is no `{ok,data}` envelope.
Row IDs are positive integers. Insert accepts a single plain row or an array of
1–1,000 rows; do not add a `{rows: ...}` wrapper or pass transport options.
Read back by a unique business key when the inserted ID is needed.

`alter(changes)` accepts only `{rename?, add_columns?, drop_columns?,
rename_columns?}`. `add_columns` uses the same column objects as `createTable`;
`drop_columns` is a string array; `rename_columns` maps old names to new names.
Do not invent methods such as `upsert`, `transaction`, `execute` or table deletion. Single-table deletion is a separate Manage-only CLI operation
described in [Management](management.md), not a method on this handle.

### Filter and paginate

`list` takes a plain object. Studio defaults to 50 rows and accepts `limit` 1–1,000;
`offset` defaults to 0. `order` is comma-separated `column.asc`/`column.desc`
(default `id.asc`); `select` is comma-separated column names (default all).
`count:"exact"` requests counts. Ordinary results include
`meta:{limit,offset,total_count?,filter_count?}`; aggregate results may omit it.

```js
const page = await db.table("todos").list({
  done: "eq.false", select: "id,title", order: "id.asc", limit: 100, offset: 0,
});
const rows = page.data;
```

Filters use column keys with `"operator.value"` strings: `eq`, `neq`, `gt`, `gte`,
`lt`, `lte`; `like`/`ilike` with `*` wildcards; `in.(a,b)`; `is.null`; or a
`not.` prefix. Use `and:"(score.gte.50,score.lte.95)"` for two filters on one
column and `or:"(status.eq.active,priority.gte.3)"` for alternatives. `search`
is a text query. Bind arbitrary user text through `db.query` parameters instead
of manually building filter expressions with reserved punctuation.

Advance `offset` by the returned row count until `data.length < limit`. Use a
stable order with a unique tie-breaker; concurrent changes can shift offset
pages. Counts are optional, so do not require them to finish pagination.
For large changing sets use `id:"gt.LAST_ID"`, `order:"id.asc"` and no offset.
Select supports `count()` and `column.sum()/avg()/min()/max()/count()`; regular
selected columns group the aggregates. Prefer named SQL aliases with `db.query`
when consuming calculated fields so their keys are explicit.

Create schema while building the app as an admin, before publishing. Do not make
normal Use-level users run schema mutations on startup. Check existing tables
before creating one. Studio manages `id`, `created_at`, and `updated_at`; omit these
from custom columns and inserted values. Column definitions use `name`, `type`,
and optional `not_null`, `unique`, or `index`. Types are `text`, `integer`,
`real`, `boolean`, `json`, `date`, and `datetime`.

```ts
await db.createTable("todos", [
  { name: "title", type: "text", not_null: true },
  { name: "done", type: "boolean" },
]);
```

Use parameter bindings for values, not string interpolation. Test against
appropriate records: agent runs affect the real database. Restoring source
never rolls back records or schema. Handle overlapping writes only when the
actual workflow requires it.

## Restart-safe imports

Give each source record a stable unique import key (for example file path,
sheet, and original row), enforced by a unique column. Validate and count rows
before writing; insert small batches. On retry, skip identical committed rows
and stop on changed payloads instead of silently overwriting. After an uncertain
write inspect committed keys, then retry deliberately with the same keys.
Return inserted/skipped/rejected counts and partial progress; cancellation does
not roll back earlier batches. Keys must match the actual source identity, not
just a name or amount that may be duplicated.

## Work on an existing app without changing its source

Use `code_sql` for a simple SELECT. Use `code_run({code, resourceId})` for a
short analysis, import, export, or structured migration against that resource.
`database.connect()` and shared files/KV bind to this explicit resource; its
source and publications stay unchanged. Manage permission is checked again for
each remote data operation. Local storage is temporary, not the user's app data.
Chat inputs are still explicit `inputPaths`. The same run input works in the CLI.

Inspect before writing. Use existing structured schema/row methods for migrations,
check whether each change is already applied, and verify the result. Do not add
migration controls to the user app just to perform a one-time task. Data changes
are real and are not undone by code restore, cancellation, or a new script.
