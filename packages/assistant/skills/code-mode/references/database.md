# App database

Read [cloud contract](cloud.md) first. Tables belong to the app across source
versions. Restoring code does not restore data; forks start without a database.

Create or change schema through the `code_database` tool with Manage permission.
For example:

```json
{"id":"APP_ID","operation":"tables.create","name":"todos","write":"own","columns":[{"name":"title","type":"text","not_null":true},{"name":"done","type":"boolean"}]}
```

Creation connects the app database if needed. Read `tables.list` or `schema.get`
before edits; update with `tables.update` and `changes`, including `write`.
Column types are text, integer, real, boolean, json, date, and datetime.
`id`, `created_at`, `updated_at`, `created_by`, and `updated_by` are managed and
must not appear in custom column definitions or write values. Audit user ids
come from trusted server identity. Existing tables gain nullable audit columns
on first access, without backfill.

| Write rule | Runtime writes |
| --- | --- |
| everyone (default) | Signed-in viewers with Use can insert, update, delete |
| own | Any signed-in viewer with Use can insert; only creators update/delete |
| managers | Only viewers with Manage can write |

Anonymous public-share visitors cannot write. A policy violation raises
`CloudError` with `code:"denied"`. Read access stays unchanged.

```js
const row = await cloud.db.insert("todos", {title:"Check totals", done:false});
const changed = await cloud.db.update("todos", row.id, {done:true});
const page = await cloud.db.list("todos", {done:true}, {order:"-updated_at",limit:100,offset:0});
```

`list` returns an array and matches plain values by equality; null means IS NULL.
Without a limit, over 1,000 matches raise `limit` with paging guidance. Explicit
limits are 1–1,000. `get`/`update` return null for missing rows; `delete` returns
whether a row existed. Single/batch inserts return the inserted row(s), including
ids and audit fields. Boolean and JSON columns retain their types.

`query(sql,params)` returns raw rows for one bounded read-only SELECT with `?`
parameters; booleans are 0/1. SQL writes, CTEs, comments, and internal objects are
rejected. Bind values; do not interpolate them. `code_sql` also allows direct
Manage-level inspection without a script. The SQL console shows table write
rules in Schema. Database backup/reset remain explicit management operations.

For restart-safe imports, enforce a unique source key, validate first, and
insert bounded batches. After an uncertain write inspect committed keys before
retrying; cancellation does not undo earlier batches.
