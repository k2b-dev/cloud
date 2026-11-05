import { expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import "../../../../scripts/fixtures/authorization-preload";
import { listOutgoingLinks, reindexLinks } from "./links";

const suite = suiteFor("database", "nats", "valkey");
const identity = () => ({ id: crypto.randomUUID(), shortId: testShortId() });

suite("Notebooks outgoing links", () => {
  test("a note's outgoing links show only targets the reader can open, all of them for admins, and at most the limit", async () => {
    const readable = identity();
    const hidden = identity();
    const source = { ...identity(), title: "Outgoing source" };
    const inside = [identity(), identity()].map((note, index) => ({ ...note, title: `Outgoing inside ${index}` }));
    const outside = { ...identity(), title: "Outgoing hidden target" };
    const readerId = crypto.randomUUID();
    const accessId = crypto.randomUUID();
    const body = `# ${source.title}\n\n${[...inside, outside].map((note) => `[${note.title}](note://${note.shortId})`).join("\n")}`;
    try {
      await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name)
        VALUES (${readerId}::uuid, ${`outgoing-reader-${readerId}`}, 'local', 'user', 'Outgoing reader')`;
      await sql`INSERT INTO notebooks.notebooks (id, short_id, name) VALUES
        (${readable.id}::uuid, ${readable.shortId}, 'Outgoing readable'),
        (${hidden.id}::uuid, ${hidden.shortId}, 'Outgoing hidden')`;
      for (const [notebook, note, content] of [
        [readable, source, body],
        [readable, inside[0]!, "# inside"],
        [readable, inside[1]!, "# inside"],
        [hidden, outside, "# hidden"],
      ] as const)
        await sql`INSERT INTO notebooks.notes (id, short_id, notebook_id, title, content_md)
          VALUES (${note.id}::uuid, ${note.shortId}, ${notebook.id}::uuid, ${note.title}, ${content})`;
      await reindexLinks(source.id, body);
      await sql`INSERT INTO auth.access (id, user_id, permission) VALUES (${accessId}::uuid, ${readerId}::uuid, 'read')`;
      await sql`INSERT INTO notebooks.notebook_access (notebook_id, access_id) VALUES (${readable.id}::uuid, ${accessId}::uuid)`;

      const titles = (links: { title: string }[]) => links.map((link) => link.title).sort();
      expect(titles(await listOutgoingLinks({ noteId: source.id, userId: readerId, limit: 100 }))).toEqual(
        inside.map((note) => note.title),
      );
      expect(titles(await listOutgoingLinks({ noteId: source.id, userId: readerId, bypassAccess: true, limit: 100 }))).toEqual(
        [...inside, outside].map((note) => note.title).sort(),
      );
      expect(await listOutgoingLinks({ noteId: source.id, userId: readerId, bypassAccess: true, limit: 2 })).toHaveLength(2);
      expect(await listOutgoingLinks({ noteId: source.id, userId: readerId, limit: 1 })).toHaveLength(1);
      const [first] = await listOutgoingLinks({ noteId: source.id, userId: null, bypassAccess: true, limit: 100 });
      expect(first).toMatchObject({ notebookId: expect.any(String), notebookName: expect.any(String) });
      expect(await listOutgoingLinks({ noteId: source.id, userId: null, limit: 100 })).toEqual([]);
    } finally {
      await sql`DELETE FROM notebooks.notebooks WHERE id IN (${readable.id}::uuid, ${hidden.id}::uuid)`;
      await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${readerId}::uuid`;
    }
  });
});
