#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { dates } from "@k2b/stdlib";
import { sql } from "bun";
import { requireDatabaseUrl } from "../../../scripts/fixtures/test-infra";
import { migrate as migrateAuth } from "../../core/src/migrate/core/auth";
import { migrate as migrateGrids } from "../src/migrate";
import { gridsService } from "../src/service";
import { validateRelationTargets } from "../src/service/relations";

type ServiceResult<T> = { ok: true; data: T } | { ok: false; error: { message?: string } };
type SmokePrincipal = { type: "user"; userId: string } | { type: "group"; groupId: string };

const { values: options } = parseArgs({
  args: Bun.argv.slice(2),
  options: { keep: { type: "boolean", default: false }, help: { type: "boolean", default: false } },
});
if (options.help) {
  console.log(`Usage: CLOUD_TEST_DATABASE_URL=postgres://.../<name>_test bun packages/grids/scripts/sql-boundary-smoke.ts [--keep]

Exercises Grids SQL boundaries (relations, permissions) on the test database.

Options:
  --keep   Keep the smoke fixture after the run
  --help   Show this help
`);
  process.exit(0);
}
requireDatabaseUrl();
const KEEP = options.keep;
const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const createdBaseIds: string[] = [];
const createdUserIds: string[] = [];
const createdGroupIds: string[] = [];

const must = <T>(result: ServiceResult<T>): T => {
  if (!result.ok) throw new Error(result.error.message ?? "service call failed");
  return result.data;
};

const assert = (condition: unknown, message: string): asserts condition => {
  if (!condition) throw new Error(message);
};

const assertHas = (values: Iterable<string>, expected: string, label: string): void => {
  const set = new Set(values);
  assert(set.has(expected), `${label}: expected ${expected}`);
};

const assertMissing = (values: Iterable<string>, unwanted: string, label: string): void => {
  const set = new Set(values);
  assert(!set.has(unwanted), `${label}: unexpected ${unwanted}`);
};

const createUser = async (label: string): Promise<string> => {
  const uid = `grids-sql-smoke-${runId}-${label}`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, given_name, sn, mail)
    VALUES (${uid}, 'local', 'user', ${`Smoke ${label}`}, 'Smoke', ${label}, ${`${uid}@example.invalid`})
    RETURNING id::text AS id
  `;
  if (!row) throw new Error("user insert returned no row");
  createdUserIds.push(row.id);
  return row.id;
};

const createGroup = async (label: string, userId: string): Promise<string> => {
  const cn = `grids-sql-smoke-${runId}-${label}`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.groups (cn, provider, name, description)
    VALUES (${cn}, 'local', ${cn}, 'Grids SQL smoke group')
    RETURNING id::text AS id
  `;
  if (!row) throw new Error("group insert returned no row");
  createdGroupIds.push(row.id);
  await sql`
    INSERT INTO auth.user_groups_v2 (user_id, group_id)
    VALUES (${userId}::uuid, ${row.id}::uuid)
  `;
  return row.id;
};

const grant = async (
  resourceType: "base" | "table" | "view" | "form",
  resourceId: string,
  principal: SmokePrincipal,
  permission: "none" | "read" | "write" | "admin",
): Promise<void> => {
  must(
    await gridsService.access.grant({
      resourceType,
      resourceId,
      principal,
      permission,
    }),
  );
};

const insertRecord = async (tableId: string, data: Record<string, unknown>, createdAt?: string): Promise<string> => {
  const id = Bun.randomUUIDv7();
  if (createdAt) {
    await sql`
      INSERT INTO grids.records (id, table_id, data, version, created_at, updated_at)
      VALUES (${id}::uuid, ${tableId}::uuid, ${data}::jsonb, 1, ${createdAt}::timestamptz, ${createdAt}::timestamptz)
    `;
  } else {
    await sql`
      INSERT INTO grids.records (id, table_id, data, version)
      VALUES (${id}::uuid, ${tableId}::uuid, ${data}::jsonb, 1)
    `;
  }
  return id;
};

const cleanup = async (): Promise<void> => {
  if (KEEP) {
    console.log(`--keep set, keeping smoke fixture run=${runId}`);
    return;
  }
  if (createdBaseIds.length > 0) {
    await sql`DELETE FROM grids.bases WHERE id = ANY(${sql.array(createdBaseIds, "UUID")})`;
  }
  if (createdUserIds.length > 0) {
    await sql`DELETE FROM auth.users WHERE id = ANY(${sql.array(createdUserIds, "UUID")})`;
  }
  if (createdGroupIds.length > 0) {
    await sql`DELETE FROM auth.groups WHERE id = ANY(${sql.array(createdGroupIds, "UUID")})`;
  }
};

const main = async (): Promise<void> => {
  console.log(`Grids SQL-boundary smoke: run=${runId}`);
  await migrateAuth();
  await migrateGrids();

  const userA = await createUser("reader");
  const userB = await createUser("owner");
  const groupA = await createGroup("team", userA);

  const base = must(await gridsService.base.create({ name: `sql-boundary-smoke-${runId}` }, null));
  createdBaseIds.push(base.id);
  await grant("base", base.id, { type: "user", userId: userA }, "read");
  const secondaryBase = must(await gridsService.base.create({ name: `sql-boundary-smoke-${runId}-archive` }, null));
  createdBaseIds.push(secondaryBase.id);
  await grant("base", secondaryBase.id, { type: "user", userId: userA }, "read");

  const firstVisiblePage = await gridsService.base.listVisible({
    userId: userA,
    userGroups: [],
    query: runId,
    limit: 1,
    offset: 0,
  });
  const secondVisiblePage = await gridsService.base.listVisible({
    userId: userA,
    userGroups: [],
    query: runId,
    limit: 1,
    offset: 1,
  });
  const emptyVisiblePage = await gridsService.base.listVisible({
    userId: userA,
    userGroups: [],
    query: "does-not-match-this-smoke",
    limit: 1,
    offset: 0,
  });
  assert(firstVisiblePage.total === 2, `base.listVisible total should be 2, got ${firstVisiblePage.total}`);
  assert(firstVisiblePage.items.length === 1, `base.listVisible first page should contain 1 row, got ${firstVisiblePage.items.length}`);
  assert(secondVisiblePage.items.length === 1, `base.listVisible second page should contain 1 row, got ${secondVisiblePage.items.length}`);
  assert(firstVisiblePage.items[0]?.id !== secondVisiblePage.items[0]?.id, "base.listVisible pagination should not repeat rows");
  assert(emptyVisiblePage.total === 0, `base.listVisible unmatched query total should be 0, got ${emptyVisiblePage.total}`);

  const recordsTable = must(await gridsService.table.create({ baseId: base.id, name: "Smoke Records" }, null));
  const defaultsTable = must(await gridsService.table.create({ baseId: base.id, name: "Default Records" }, null));
  const hiddenTable = must(await gridsService.table.create({ baseId: base.id, name: "Hidden Records" }, null));
  const targetTable = must(await gridsService.table.create({ baseId: base.id, name: "Lookup Targets" }, null));
  await grant("table", hiddenTable.id, { type: "user", userId: userA }, "none");

  const title = must(
    await gridsService.field.create(
      {
        tableId: recordsTable.id,
        name: "Title",
        type: "text",
        presentable: true,
      },
      null,
    ),
  );
  const day = must(
    await gridsService.field.create(
      {
        tableId: recordsTable.id,
        name: "Day",
        type: "date",
      },
      null,
    ),
  );
  const amount = must(
    await gridsService.field.create(
      {
        tableId: recordsTable.id,
        name: "Amount",
        type: "number",
      },
      null,
    ),
  );
  const targetLabel = must(
    await gridsService.field.create(
      {
        tableId: targetTable.id,
        name: "Label",
        type: "text",
        presentable: true,
      },
      null,
    ),
  );
  const defaultDay = must(
    await gridsService.field.create(
      {
        tableId: defaultsTable.id,
        name: "Default Day",
        type: "date",
        defaultValue: { kind: "now" },
      },
      null,
    ),
  );
  const defaultTime = must(
    await gridsService.field.create(
      {
        tableId: defaultsTable.id,
        name: "Default Time",
        type: "date",
        config: { includeTime: true },
        defaultValue: { kind: "now" },
      },
      null,
    ),
  );

  const defaultDateConfig = { timeZone: "Europe/Berlin" };
  const beforeDefaultCreate = Date.now();
  const defaultedRecord = must(await gridsService.record.create(defaultsTable.id, {}, null, { dateConfig: defaultDateConfig }));
  const afterDefaultCreate = Date.now();
  const expectedDefaultDays = new Set([
    dates.formatDateKey(new Date(beforeDefaultCreate), defaultDateConfig),
    dates.formatDateKey(new Date(afterDefaultCreate), defaultDateConfig),
  ]);
  assert(
    expectedDefaultDays.has(String(defaultedRecord.data[defaultDay.id])),
    `date now default should materialize in configured timezone, got ${String(defaultedRecord.data[defaultDay.id])}`,
  );
  const defaultTimeValue = defaultedRecord.data[defaultTime.id];
  const defaultTimeMillis = typeof defaultTimeValue === "string" ? Date.parse(defaultTimeValue) : NaN;
  assert(
    Number.isFinite(defaultTimeMillis) &&
      defaultTimeMillis >= beforeDefaultCreate - 1_000 &&
      defaultTimeMillis <= afterDefaultCreate + 1_000,
    `datetime now default should materialize server-side, got ${String(defaultTimeValue)}`,
  );

  const sharedView = must(await gridsService.view.create({ tableId: recordsTable.id, name: "Shared View" }, null));
  const privateView = must(
    await gridsService.view.create(
      {
        tableId: recordsTable.id,
        name: "Private View",
        ownerUserId: userB,
      },
      null,
    ),
  );
  const grantedView = must(
    await gridsService.view.create(
      {
        tableId: recordsTable.id,
        name: "Granted View",
        ownerUserId: userB,
      },
      null,
    ),
  );
  const deniedView = must(await gridsService.view.create({ tableId: recordsTable.id, name: "Denied Shared View" }, null));
  const groupView = must(
    await gridsService.view.create(
      {
        tableId: recordsTable.id,
        name: "Group View",
        ownerUserId: userB,
      },
      null,
    ),
  );
  await grant("view", grantedView.id, { type: "user", userId: userA }, "read");
  await grant("view", deniedView.id, { type: "user", userId: userA }, "none");
  await grant("view", groupView.id, { type: "group", groupId: groupA }, "read");

  const publicForm = must(
    await gridsService.form.create(
      {
        tableId: recordsTable.id,
        name: "Public Form",
        config: { fields: [{ kind: "user_input", fieldId: title.id }] },
        isPublic: true,
      },
      null,
    ),
  );
  const privateForm = must(
    await gridsService.form.create(
      {
        tableId: recordsTable.id,
        name: "Private Form",
        config: { fields: [{ kind: "user_input", fieldId: title.id }] },
      },
      null,
    ),
  );
  const writeForm = must(
    await gridsService.form.create(
      {
        tableId: recordsTable.id,
        name: "Write Form",
        config: { fields: [{ kind: "user_input", fieldId: title.id }] },
      },
      null,
    ),
  );
  const inactivePublicForm = must(
    await gridsService.form.create(
      {
        tableId: recordsTable.id,
        name: "Inactive Public Form",
        config: { fields: [{ kind: "user_input", fieldId: title.id }] },
        isPublic: true,
      },
      null,
    ),
  );
  must(await gridsService.form.update(inactivePublicForm.id, { isActive: false }, null));
  await grant("form", writeForm.id, { type: "user", userId: userA }, "write");

  const catalog = await gridsService.base.catalog({
    baseId: base.id,
    userId: userA,
    userGroups: [],
  });
  const catalogTables = catalog.tables.map((table) => table.name);
  assertHas(catalogTables, recordsTable.name, "base.catalog tables");
  assertHas(catalogTables, targetTable.name, "base.catalog tables");
  assertMissing(catalogTables, hiddenTable.name, "base.catalog tables");
  assert(catalog.tableLevels[recordsTable.id] === "read", "base.catalog table level should inherit base read");
  assert(
    catalog.fieldsByTable[recordsTable.id]?.some((field) => field.id === day.id),
    "base.catalog should include visible table fields",
  );

  const catalogViews = (catalog.viewsByTable[recordsTable.id] ?? []).map((view) => view.name);
  assertHas(catalogViews, sharedView.name, "base.catalog views");
  assertHas(catalogViews, grantedView.name, "base.catalog views");
  assertMissing(catalogViews, privateView.name, "base.catalog views");
  assertMissing(catalogViews, deniedView.name, "base.catalog views");
  assertHas(catalogViews, groupView.name, "base.catalog resolves group views from authoritative membership");

  const sidebarForms = catalog.sidebarForms.map(({ form }) => form.name);
  assertMissing(sidebarForms, publicForm.name, "public token does not grant authenticated form-write access");
  assertHas(sidebarForms, writeForm.name, "base.catalog sidebar forms");
  assertMissing(sidebarForms, privateForm.name, "base.catalog sidebar forms");
  assertMissing(sidebarForms, inactivePublicForm.name, "base.catalog sidebar forms");
  assert(catalog.formLevels[privateForm.id] === undefined, "base.catalog should omit forms without submit access");
  assert(catalog.formLevels[writeForm.id] === "write", "base.catalog write form level should use form ACL");

  // Caller-supplied group ids are deprecated and intentionally ignored. The
  // effective group set is derived recursively from the authenticated user.
  const groupCatalog = await gridsService.base.catalog({
    baseId: base.id,
    userId: userA,
    userGroups: [groupA],
  });
  assertHas(
    (groupCatalog.viewsByTable[recordsTable.id] ?? []).map((view) => view.name),
    groupView.name,
    "base.catalog group views",
  );
  const listedViews = (
    await gridsService.view.listForTable({
      tableId: recordsTable.id,
      userId: userA,
      userGroups: [],
    })
  ).map((view) => view.name);
  assertHas(listedViews, sharedView.name, "views.listForTable");
  assertHas(listedViews, grantedView.name, "views.listForTable");
  assertMissing(listedViews, privateView.name, "views.listForTable");
  assertMissing(listedViews, deniedView.name, "views.listForTable");
  assertHas(listedViews, groupView.name, "views.listForTable resolves authoritative group ACLs");
  assertHas(
    (
      await gridsService.view.listForTable({
        tableId: recordsTable.id,
        userId: userA,
        userGroups: [groupA],
      })
    ).map((view) => view.name),
    groupView.name,
    "views.listForTable group ACL",
  );

  const alphaOneId = await insertRecord(targetTable.id, { [targetLabel.id]: "Alpha One" }, "2026-05-18T08:00:00Z");
  const alphaTwoId = await insertRecord(targetTable.id, { [targetLabel.id]: "Alpha Two" }, "2026-05-18T08:01:00Z");
  await insertRecord(targetTable.id, { [targetLabel.id]: "Beta" }, "2026-05-18T08:02:00Z");
  const lookup = await gridsService.relations.lookup({
    targetTableId: targetTable.id,
    q: "Alpha",
    excludeIds: [alphaOneId],
    limit: 10,
  });
  const lookupIds = lookup.items.map((item) => item.id);
  assertHas(lookupIds, alphaTwoId, "relation lookup excludeIds");
  assertMissing(lookupIds, alphaOneId, "relation lookup excludeIds");

  const missingTargetId = Bun.randomUUIDv7();
  const relationValidation = await validateRelationTargets(targetTable.id, [alphaOneId, missingTargetId]);
  assert(!relationValidation.ok, "validateRelationTargets should reject missing UUID");
  assert(relationValidation.missing.includes(missingTargetId), "validateRelationTargets should report missing UUID");

  for (const month of [1, 2, 3, 4, 5]) {
    await insertRecord(
      recordsTable.id,
      {
        [title.id]: `Month ${month}`,
        [day.id]: `2026-${String(month).padStart(2, "0")}-01`,
        [amount.id]: month * 10,
      },
      `2026-${String(month).padStart(2, "0")}-01T12:00:00Z`,
    );
  }

  const listResult = must(
    await gridsService.record.list({
      tableId: recordsTable.id,
      filter: { fieldId: amount.id, op: ">=", value: 30 },
      search: { q: "Month", fieldIds: [title.id] },
      sort: [{ fieldId: amount.id, direction: "desc" }],
      limit: 10,
      includeAggregates: true,
    }),
  );
  assert(listResult.items.length === 3, `record.list expected 3 rows, got ${listResult.items.length}`);
  assert(listResult.items[0]?.data[amount.id] === 50, "record.list sort should put amount=50 first");
  assert(listResult.items[2]?.data[amount.id] === 30, "record.list sort should put amount=30 last");
  assert(
    listResult.aggregates?.["*__count"] === 3,
    `record.list aggregate count should be 3, got ${String(listResult.aggregates?.["*__count"])}`,
  );
  assert(
    listResult.aggregates?.[`${amount.id}__sum`] === 120,
    `record.list amount sum should be 120, got ${String(listResult.aggregates?.[`${amount.id}__sum`])}`,
  );

  const grouped = must(
    await gridsService.record.group({
      tableId: recordsTable.id,
      groupBy: [{ fieldId: day.id, granularity: "month", direction: "asc" }],
      aggregations: [{ fieldId: "*", agg: "count" }],
      limit: 3,
      fromEnd: true,
    }),
  );
  assert(grouped.buckets.length === 3, `group fromEnd expected 3 buckets, got ${grouped.buckets.length}`);
  const groupKeys = grouped.buckets.map((bucket) => String(bucket.keys[0]));
  assert(groupKeys[0]?.startsWith("2026-03"), `group fromEnd first key should be March, got ${groupKeys[0]}`);
  assert(groupKeys[1]?.startsWith("2026-04"), `group fromEnd second key should be April, got ${groupKeys[1]}`);
  assert(groupKeys[2]?.startsWith("2026-05"), `group fromEnd third key should be May, got ${groupKeys[2]}`);
  for (const bucket of grouped.buckets) {
    assert(bucket.values["*__count"] === 1, `group fromEnd count should be 1, got ${String(bucket.values["*__count"])}`);
  }
  assert(grouped.nextCursor === null, "group fromEnd should not emit a cursor");

  console.log(
    "PASS: base.listVisible, base.catalog, group ACLs, inactive forms, record.list SQL paths, widget resolver tails, relation UUID arrays, grouped fromEnd tail-window",
  );
};

try {
  await main();
} finally {
  await cleanup();
  await sql.end();
}
