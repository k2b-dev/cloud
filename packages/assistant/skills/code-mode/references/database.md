# Resource database

Use a database when the saved app or script needs structured records and SQL
analysis. A resource does not get a database automatically. Connect explicitly:

```ts
const db = await database.connect();
```

Connecting is idempotent and lazily creates this resource's database. The host
logs a successful connection. An unconfigured Cloud instance throws an error with
`error.code === "DB_NOT_CONFIGURED"`; explain that an administrator must
configure the Assistant rsql connection. Do not invent credentials or fall back to Kit settings.
`DB_AUTH_FAILED` means the stored server token was rejected; `DB_UNREACHABLE`
means the server could not be reached. Ask an administrator to check the
connection. For `DB_TIMEOUT`, a read can be retried once. For a write, inspect
its effects before retrying; a timeout does not prove that nothing changed.

The database belongs to the resource across edits, publications, and restores.
A fork starts without one. One-off scripts must be saved before using a resource
database. Database calls always use the current user's permissions.

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
const rows = await db.query("SELECT title FROM todos WHERE done = ?", [false]);
const tables = await db.tables();
const todos = db.table("todos");
await todos.insert({ title: "Check totals", done: false });
```

`query(sql, params)` returns `{data: rows}` (an empty array for no matches) and
accepts bounded SELECT queries with positional parameters.
It rejects SQL writes, CTEs, comments, and internal database objects. Use
structured methods for mutations. Query results are bounded to 1,000 rows;
read the returned result shape and paginate structured row lists when needed.

| Call | Purpose |
| --- | --- |
| `db.tables()` | List tables |
| `db.createTable(name, columns)` | Create schema; requires Manage |
| `db.table(name).schema()` | Read column definitions |
| `db.table(name).alter(changes)` | Explicit schema changes; requires Manage |
| `db.table(name).list(query)` | Filter and paginate records |
| `db.table(name).get(id)` | Read one record |
| `db.table(name).insert(rowOrRows)` | Insert one row or batch |
| `db.table(name).update(id, values)` | Update supplied fields |
| `db.table(name).delete(id)` | Delete one record |

Create schema while building the app as an admin, before publishing. Do not make
normal Use-level users run schema mutations on startup. Check existing tables
before creating one. rsql manages `id`, `created_at`, and `updated_at`; omit these
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
