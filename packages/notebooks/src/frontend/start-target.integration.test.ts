import { afterAll, beforeAll, expect } from "bun:test";
import { sql } from "@k2b/cloud";
import { notebooksService } from "@/service";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import { startTarget } from "./start-target";

// What `/app/notebooks` costs before it renders (W2, the first start): a person without a notebook pays one list of one
// row, a person who comes back to the notebook they used last pays that notebook and their access to it, and nothing
// scales with how many notebooks there are. The first start itself reads nothing more: its templates are code.
const databaseTest = testFor("database");
const newcomer = crypto.randomUUID();
const regular = crypto.randomUUID();
const notebookIds: string[] = [];
const cookie = (shortId: string) => `settings-app-notebooks=${encodeURIComponent(JSON.stringify({ lastNotebookId: shortId }))}`;

beforeAll(async () => {
  if (!testInfra.database) return;
  await migrate();
  for (const [id, name] of [
    [newcomer, "Lea Neu"],
    [regular, "Ben Stamm"],
  ] as const)
    await sql`INSERT INTO auth.users (id, uid, display_name, provider, profile)
      VALUES (${id}::uuid, ${`start-target-${id}`}, ${name}, 'local', 'user')`;
  // the regular has many notebooks: the cost must not grow with them
  for (const name of ["Werkstatt", "Abrechnung", "Zeltlager", "Bibliothek", "Mensa", "Archiv"]) {
    const created = await notebooksService.notebook.create({ data: { name }, creatorId: regular, seedWelcome: false });
    if (!created.ok) throw new Error(`start target: notebook ${name} not created`);
    notebookIds.push(created.data.id);
  }
}, 30_000);

afterAll(async () => {
  if (!testInfra.database) return;
  for (const id of notebookIds) await sql`DELETE FROM notebooks.notebooks WHERE id = ${id}::uuid`;
  await sql`DELETE FROM auth.users WHERE id IN (${newcomer}::uuid, ${regular}::uuid)`;
});

databaseTest("a person without a notebook reaches the first start after one bounded list of one row", async () => {
  const meter = await meterSql();
  try {
    const targets: (string | null)[] = [];
    const statements = await meter.during(async () => {
      targets.push(await startTarget(newcomer, undefined));
    });
    expect(targets).toEqual([null]);
    expect(statements.length).toBe(START_NEW);
  } finally {
    await meter.close();
  }
});

databaseTest("a person who comes back opens the notebook used last, and the cost does not grow with their notebooks", async () => {
  const [last] = await sql<{ short_id: string }[]>`SELECT short_id FROM notebooks.notebooks WHERE id = ${notebookIds[3]!}::uuid`;
  const meter = await meterSql();
  try {
    const targets: (string | null)[] = [];
    const statements = await meter.during(async () => {
      targets.push(await startTarget(regular, cookie(last!.short_id)));
    });
    expect(targets).toEqual([last!.short_id]);
    expect(statements.length).toBe(START_LAST);
    // without a cookie (or with one for a notebook that is gone): the first by name, one bounded list
    const firsts: (string | null)[] = [];
    const fallback = await meter.during(async () => {
      firsts.push(await startTarget(regular, cookie("gone0000")));
    });
    const [byName] = await sql<{ short_id: string }[]>`
      SELECT short_id FROM notebooks.notebooks WHERE id = ANY(${notebookIds}::uuid[]) ORDER BY LOWER(name) LIMIT 1`;
    expect(firsts).toEqual([byName!.short_id]);
    expect(fallback.length).toBe(1 + START_NEW);
  } finally {
    await meter.close();
  }
});

/**
 * Statements, measured on 27.11. and pinned: a person without a notebook pays the list of one row and its count; one who
 * returns to the notebook used last pays that notebook and the reading of their access to it.
 */
const START_NEW = 2;
const START_LAST = 3;
