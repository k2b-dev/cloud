---
id: kit-sql-console
title: "Inspect data with the SQL console"
icon: ti ti-terminal
description: "Browse tables, run SELECT queries and save shared queries."
order: 50
---

## Open the console {icon="terminal"}

Open **SQL console** in the app sidebar after an app administrator enables its
shared database. It is available from both use and edit mode. You do not need
to launch a script. If database access is disabled or unavailable, refresh its
status after an administrator restores access.

## Browse and query {icon="table"}

Select a table to browse 50 records per page, or choose **Structure** to inspect
its columns. **Open as query** prepares a SELECT in the editor. It does not run
the query or replace an unsaved draft without asking.

The monospace editor highlights SQL without autocomplete. Click **Run**, or
press Ctrl/Cmd+Enter. Only SELECT queries in Kit's supported subset are accepted.
One final semicolon is allowed; multiple statements, CTEs, comments and write
statements are not. See [database reference](/app/kit/help/kit-sdk-db).

Results are limited to 1,000 rows and 16 MiB. A larger result fails explicitly:
add LIMIT/OFFSET or select fewer columns. Requests have a 15-second upstream
timeout. **Cancel** stops waiting and requests cancellation; it is not a
guarantee of immediate server-side termination. Queries never write data.

The result shows its row count and elapsed time. If you edit the SQL afterwards,
the previous result is marked accordingly. **Export CSV** downloads only the
displayed result, with semicolons and a UTF-8 BOM.

## Save a query {icon="device-floppy"}

App admins can **Save**, rename and delete shared queries.
Ctrl/Cmd+S saves. Users with Use permission can read saved queries, edit an
unsaved copy and execute them. Opening a saved query never executes it.

Saved queries contain a name and SQL text, not results. They are shared across
users and devices. Saving checks the revision: if someone changed or deleted
the query, your draft is preserved. Copy your SQL before opening the latest query.

Unsaved SQL prompts before replacement or leaving the page. Drafts are not
persisted across reloads. Saved queries remain when the database is disabled or
reset. They are deleted with the Kit app. After a reset, refresh and explicitly
run queries again; old table references may no longer exist.

## Use the CLI {icon="code"}

Use the following commands to inspect queries:

    cld kit queries list <app-id>
    cld kit queries get <app-id> <query-id>

Create accepts a JSON object with name and sql through `--input-file` (or `--stdin`); update also
requires revision. Delete requires `--revision` and `--yes`. Run requires the
revision you inspected through `--revision`.

The same app permissions apply to UI and CLI. Saving SQL is not execution.

Use **Info** in the results panel to see each table once, with its row count, column names and types while keeping the SQL editor open. Query errors also appear in this panel. **Save** asks for a name for a new query and updates an existing query.

Agents can inspect the same structure with the existing read-only capabilities: get the generation from `kit.database.status`, then call `kit.database.read` with `tables.list` and `schema.get` for each needed table. These operations require Use permission and do not change data.

**Save** sits beside **Refresh**. For a new query, entering an existing exact name asks before replacing its saved SQL. Concurrent changes reject the overwrite. Saved queries appear in the sidebar only once there are entries; each query has a hover menu for **Rename** and **Delete**. Names are unique within each app. Renaming leaves unsaved editor changes intact.

Table browsing uses a single **Data / Structure** selector. The table actions menu contains **Open as query** and **Export CSV**. Pagination appears only when there are multiple pages. In the SQL result drawer, the results menu contains **Export CSV**.

## SQL basics {icon="school"}

Replace `todos` and the columns with names from **Info**. Run each example separately.

### Select, filter and sort

```sql
SELECT id, title FROM todos WHERE done = 0 ORDER BY id DESC LIMIT 50;
```

`SELECT` chooses columns, `FROM` the table, `WHERE` filters, and `ORDER BY` sorts. `DESC` means descending. Put text in single quotes:

```sql
SELECT id, title FROM todos WHERE title LIKE '%invoice%' LIMIT 50;
```

### Count and group

```sql
SELECT done, COUNT(*) AS count FROM todos GROUP BY done;
```

`SUM(amount_cents)` adds an existing amount column; `AVG` calculates its average. Check the actual column names in **Info** first.

### Missing values and more pages

```sql
SELECT id, title FROM todos WHERE title IS NULL LIMIT 50;
```

Use `IS NULL`, not `= NULL`. Read the next page with stable ordering and `OFFSET`:

```sql
SELECT id, title FROM todos ORDER BY id LIMIT 50 OFFSET 50;
```

### Parameters for agents

The `kit.database.sql` capability takes `id`, the current `generation`, `sql`, and `params`. Example: `sql: "SELECT id, title FROM todos WHERE title = ? LIMIT 50"` with `params: ["Review invoice"]`. Values are bound; do not concatenate them into SQL. The GUI currently has no separate parameter input.

Check unknown table or column names in **Info**. `SELECT * FROM *` is invalid: `FROM` needs a table name. Narrow rows and columns when results exceed the limit. SQL writes are unsupported; agents use `kit.database.write` with approval instead.
