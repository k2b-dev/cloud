import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { migrate } from "../migrate";
import { repairNoteDataProperties } from "./note-properties";
import { reindexNotebook } from "./note-refs";

const postgresTest = process.env.NOTEBOOKS_DB_TEST === "1" ? test : test.skip;
const notebookId = crypto.randomUUID();
const noteId = crypto.randomUUID();

beforeAll(async () => {
  if (process.env.NOTEBOOKS_DB_TEST !== "1") return;
  await migrate();
  await migrate();
  await sql`
    INSERT INTO notebooks.notebooks (id, name)
    VALUES (${notebookId}::uuid, 'Property projection test')
  `;
  await sql`
    INSERT INTO notebooks.notes (id, notebook_id, title, content_md)
    VALUES (${noteId}::uuid, ${notebookId}::uuid, 'Projection', '@meta\n:::data\nstatus: draft\n:::')
  `;
});

afterAll(async () => {
  if (process.env.NOTEBOOKS_DB_TEST !== "1") return;
  await sql`DELETE FROM notebooks.notebooks WHERE id = ${notebookId}::uuid`;
});

postgresTest("migrates and repairs the JSONB projection without overwriting a concurrent save", async () => {
  const original = "@meta\n:::data\nstatus: draft\n:::";
  expect(await repairNoteDataProperties({ noteId, contentMd: original })).toBe(true);

  const [repaired] = await sql<{ data_properties: unknown }[]>`
    SELECT data_properties FROM notebooks.notes WHERE id = ${noteId}::uuid
  `;
  expect(repaired?.data_properties).toEqual({ meta: { status: "draft" } });

  const newer = "@meta\n:::data\nstatus: published\n:::";
  await sql`
    UPDATE notebooks.notes
    SET content_md = ${newer}, data_properties = ${{ meta: { status: "published" } }}::jsonb
    WHERE id = ${noteId}::uuid
  `;
  expect(await repairNoteDataProperties({ noteId, contentMd: original })).toBe(false);

  const [afterRace] = await sql<{ content_md: string; data_properties: unknown }[]>`
    SELECT content_md, data_properties FROM notebooks.notes WHERE id = ${noteId}::uuid
  `;
  expect(afterRace).toMatchObject({ content_md: newer, data_properties: { meta: { status: "published" } } });

  await sql`UPDATE notebooks.notes SET data_properties = '{}'::jsonb WHERE id = ${noteId}::uuid`;
  expect(await reindexNotebook({ notebookId })).toEqual({ notes: 1, failed: 0 });
  const [scheduledRepair] = await sql<{ content_md: string; data_properties: unknown }[]>`
    SELECT content_md, data_properties FROM notebooks.notes WHERE id = ${noteId}::uuid
  `;
  expect(scheduledRepair).toMatchObject({ content_md: newer, data_properties: { meta: { status: "published" } } });
});
