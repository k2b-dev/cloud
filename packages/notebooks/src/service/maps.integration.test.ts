import { afterAll, beforeAll, describe, expect } from "bun:test";
import { serializeGeoDocument } from "@k2b/cloud/geo/document";
import { sql } from "bun";
import { testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import { fictionalMap, fictionalRouteMap } from "../lib/map.test-fixture";
import { migrate } from "../migrate";
import { loadBookBlockPreview, loadBookNote } from "./book";

const databaseTest = testFor("database");
const notebookId = crypto.randomUUID();
const otherNotebookId = crypto.randomUUID();
const notebookShortId = testShortId();
const noteShortId = testShortId();
const foreignNoteShortId = testShortId();
const accessId = crypto.randomUUID();
const userId = crypto.randomUUID();
const markdown = `${serializeGeoDocument(fictionalMap())}\n\n${serializeGeoDocument(fictionalRouteMap())}`;

beforeAll(async () => {
  if (!testInfra.database) return;
  await migrate();
  await sql`INSERT INTO auth.users (id, uid, provider, profile) VALUES (${userId}::uuid, ${`map-${testShortId()}`}, 'local', 'user')`;
  await sql`INSERT INTO notebooks.notebooks (id, short_id, name) VALUES (${notebookId}::uuid, ${notebookShortId}, 'Fictional map plan'), (${otherNotebookId}::uuid, ${testShortId()}, 'Other fictional plan')`;
  await sql`INSERT INTO auth.access (id, user_id, permission) VALUES (${accessId}::uuid, ${userId}::uuid, 'read')`;
  await sql`INSERT INTO notebooks.notebook_access (notebook_id, access_id) VALUES (${notebookId}::uuid, ${accessId}::uuid)`;
  await sql`INSERT INTO notebooks.notes (short_id, notebook_id, title, content_md) VALUES (${noteShortId}, ${notebookId}::uuid, 'Saved map', ${markdown}), (${foreignNoteShortId}, ${otherNotebookId}::uuid, 'Foreign map', ${markdown})`;
}, 30_000);
afterAll(async () => {
  if (!testInfra.database) return;
  await sql`DELETE FROM notebooks.notebooks WHERE id IN (${notebookId}::uuid, ${otherNotebookId}::uuid)`;
  await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
  await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
}, 30_000);

const params = () => ({ notebookId, notebookShortId, noteShortId, userId, locale: "en" });
describe("saved map documents use the Notebook read/write boundary", () => {
  databaseTest("stored maps and complete routes survive the authorized Book read without a provider call", async () => {
    const loaded = await loadBookNote(params());
    expect(loaded?.note.contentMd).toBe(markdown);
    expect(loaded?.document.blocks).toHaveLength(2);
    expect(loaded?.document.html).toContain("Geoapify");
  });
  databaseTest("authorized SSR resolves availability under its reader; denied reads make no Geo call", async () => {
    const originalOrigin = process.env.CLOUD_CORE_INTERNAL_ORIGIN;
    process.env.CLOUD_CORE_INTERNAL_ORIGIN = "https://core.example.test";
    let calls = 0;
    const geoCaller = {
      locale: "de",
      cookie: "session=fictional",
      transport: async (request: Request) => {
        calls++;
        expect(request.headers.get("cookie")).toBe("session=fictional");
        expect(request.headers.get("x-cloud-locale")).toBe("de");
        return Response.json({
          data: {
            configured: false,
            person: { exhausted: false, resetsAt: "2026-10-23T00:00:00Z" },
            cloud: { exhausted: false, resetsAt: "2026-11-01T00:00:00Z" },
          },
        });
      },
    };
    try {
      expect(await loadBookNote({ ...params(), userId: crypto.randomUUID(), geoCaller })).toBeNull();
      expect(calls).toBe(0);
      const result = await loadBookNote({ ...params(), geoCaller });
      expect(calls).toBe(1);
      expect(result?.document.html).not.toContain('class="k2b-map-view');
      expect(result?.document.html).toContain("Maps are not configured");
    } finally {
      if (originalOrigin === undefined) delete process.env.CLOUD_CORE_INTERNAL_ORIGIN;
      else process.env.CLOUD_CORE_INTERNAL_ORIGIN = originalOrigin;
    }
  });
  databaseTest("readers preview saved maps, while draft maps require write permission", async () => {
    expect((await loadBookBlockPreview(params())).kind).toBe("ok");
    expect((await loadBookBlockPreview({ ...params(), markdown })).kind).toBe("denied");
    expect(await loadBookNote({ ...params(), userId: crypto.randomUUID() })).toBeNull();
  });
  databaseTest("a foreign note ID is never admitted under the accessible notebook", async () => {
    expect(await loadBookNote({ ...params(), noteShortId: foreignNoteShortId })).toBeNull();
    expect((await loadBookBlockPreview({ ...params(), noteShortId: foreignNoteShortId })).kind).toBe("not_found");
  });
  databaseTest("writers preview map drafts; locking the note blocks draft previews", async () => {
    await sql`UPDATE auth.access SET permission = 'write' WHERE id = ${accessId}::uuid`;
    try {
      expect((await loadBookBlockPreview({ ...params(), markdown })).kind).toBe("ok");
      await sql`UPDATE notebooks.notes SET locked_at = '2026-10-20T12:00:00Z' WHERE short_id = ${noteShortId}`;
      expect((await loadBookBlockPreview({ ...params(), markdown })).kind).toBe("denied");
      expect((await loadBookBlockPreview(params())).kind).toBe("ok");
    } finally {
      await sql`UPDATE notebooks.notes SET locked_at = NULL WHERE short_id = ${noteShortId}`;
      await sql`UPDATE auth.access SET permission = 'read' WHERE id = ${accessId}::uuid`;
    }
  });
});
