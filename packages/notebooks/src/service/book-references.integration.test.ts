import { afterAll, beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import { migrate } from "../migrate";
import { resolveBookReferences } from "./book";

const postgresTest = testFor("database");
const id = () => crypto.randomUUID();

const notebookId = id();
const otherNotebookId = id();
const colorsShortId = testShortId();
const kickoffShortId = testShortId();
const foreignShortId = testShortId();
const guideShortId = testShortId();
const foreignFileShortId = testShortId();

beforeAll(async () => {
  if (!testInfra.database) return;
  await migrate();
  await sql`
    INSERT INTO notebooks.notebooks (id, short_id, name) VALUES
      (${notebookId}::uuid, ${testShortId()}, 'Brand'),
      (${otherNotebookId}::uuid, ${testShortId()}, 'Private')
  `;
  await sql`
    INSERT INTO notebooks.notes (id, short_id, notebook_id, title, content_md) VALUES
      (${id()}::uuid, ${colorsShortId}, ${notebookId}::uuid, 'Farbsystem', ''),
      (${id()}::uuid, ${kickoffShortId}, ${notebookId}::uuid, 'Kickoff', ''),
      (${id()}::uuid, ${foreignShortId}, ${otherNotebookId}::uuid, 'Secret plans', '')
  `;
  await sql`
    INSERT INTO notebooks.attachments (id, short_id, notebook_id, filename, mime_type, size_bytes, kind, content) VALUES
      (${id()}::uuid, ${guideShortId}, ${notebookId}::uuid, 'Markenrichtlinien-2026.pdf', 'application/pdf', 4200000, 'file', '\\x00'::bytea),
      (${id()}::uuid, ${foreignFileShortId}, ${otherNotebookId}::uuid, 'salaries.xlsx', 'application/vnd.ms-excel', 10, 'file', '\\x00'::bytea)
  `;
}, 30_000);

afterAll(async () => {
  if (!testInfra.database) return;
  await sql`DELETE FROM notebooks.notebooks WHERE id IN (${notebookId}::uuid, ${otherNotebookId}::uuid)`;
}, 30_000);

describe("Book references", () => {
  postgresTest("resolve linked headings' notes and attachments of the reader's notebook only", async () => {
    const markdown = [
      `[Akzentfarbe](note://${colorsShortId}#akzentfarbe) [Kickoff](note://${kickoffShortId})`,
      `[Plan](note://${foreignShortId}#plan) [Guide](attach://${guideShortId}) [Sheet](attach://${foreignFileShortId})`,
    ].join("\n");
    const references = await resolveBookReferences({ notebookId, markdown });

    // Only notes whose headings are linked need a title, and none from another notebook.
    expect([...(references.notes ?? [])]).toEqual([[colorsShortId, "Farbsystem"]]);
    expect([...(references.attachments ?? [])]).toEqual([[guideShortId, { filename: "Markenrichtlinien-2026.pdf", sizeBytes: 4_200_000 }]]);
    expect(await resolveBookReferences({ notebookId, markdown: "No links." })).toEqual({ notes: new Map(), attachments: new Map() });
  });
});
