import { afterAll, beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { collectPages, descending } from "../../../../scripts/fixtures/stable-paging";
import { testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import { searchPaginated } from "./attachments";
import { listPaged, listVersions } from "./notes";
import { listNotesForTag } from "./tags";

const postgresTest = testFor("database");
const shortId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 8);

/** Enough tied rows that a page size of three crosses several boundaries inside the tie. */
const ROWS = 12;

const notebookId = crypto.randomUUID();
let noteIds: string[] = [];
let versionIds: string[] = [];
let attachmentIds: string[] = [];

beforeAll(async () => {
  if (!testInfra.database) return;
  await migrate();
  // One transaction shares one now(): every note, version, and attachment ties on its timestamp.
  await sql.begin(async (tx) => {
    await tx`INSERT INTO notebooks.notebooks (id, short_id, name) VALUES (${notebookId}::uuid, ${shortId()}, 'Stable paging')`;
    noteIds = [];
    versionIds = [];
    attachmentIds = [];
    for (let index = 0; index < ROWS; index++) {
      const [note] = await tx<{ id: string }[]>`
        INSERT INTO notebooks.notes (short_id, notebook_id, title, content_md)
        VALUES (${shortId()}, ${notebookId}::uuid, ${`Tied ${index}`}, '#tied')
        RETURNING id
      `;
      noteIds.push(note!.id);
      await tx`INSERT INTO notebooks.note_tags (note_id, notebook_id, tag) VALUES (${note!.id}::uuid, ${notebookId}::uuid, 'tied')`;
      const [attachment] = await tx<{ id: string }[]>`
        INSERT INTO notebooks.attachments (short_id, notebook_id, filename, mime_type, size_bytes, kind, content)
        VALUES (${shortId()}, ${notebookId}::uuid, ${`tied-${index}.txt`}, 'text/plain', 1, 'file', ${new Uint8Array([1])})
        RETURNING id
      `;
      attachmentIds.push(attachment!.id);
    }
    for (let index = 0; index < ROWS; index++) {
      const [version] = await tx<{ id: string }[]>`
        INSERT INTO notebooks.note_versions (note_id, yjs_snapshot) VALUES (${noteIds[0]!}::uuid, ${new Uint8Array([index])})
        RETURNING id
      `;
      versionIds.push(version!.id);
    }
  });
}, 30_000);

afterAll(async () => {
  if (!testInfra.database) return;
  await sql`DELETE FROM notebooks.notebooks WHERE id = ${notebookId}::uuid`;
});

describe("notebook offset pages over rows that share one timestamp", () => {
  postgresTest("notes", async () => {
    const seen = await collectPages(async ({ offset, limit }) => {
      const result = await listPaged({ notebookId, pagination: { offset, limit } });
      return result.items.map((note) => note.id);
    });
    expect(seen).toEqual(descending(noteIds));
  });

  postgresTest("notes for a tag", async () => {
    const seen = await collectPages(async ({ offset, limit }) => {
      const result = await listNotesForTag({ notebookId, tag: "tied", pagination: { offset, limit } });
      return result.items.map((note) => note.id);
    });
    expect(seen).toEqual(descending(noteIds));
  });

  postgresTest("attachments", async () => {
    const seen = await collectPages(async ({ offset, limit }) => {
      const result = await searchPaginated({ notebookId, pagination: { offset, limit } });
      return result.items.map((attachment) => attachment.id);
    });
    expect(seen).toEqual(descending(attachmentIds));
  });

  postgresTest("note versions", async () => {
    const seen = await collectPages(async ({ page, offset, limit }) => {
      const result = await listVersions({ noteId: noteIds[0]!, pagination: { page, offset, perPage: limit } });
      return result.versions.map((version) => version.id);
    });
    expect(seen).toEqual(descending(versionIds));
  });
});
