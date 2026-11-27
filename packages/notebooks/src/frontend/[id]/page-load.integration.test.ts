import { suiteFor } from "../../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../../scripts/fixtures/test-short-id";
import "../../../../../scripts/fixtures/authorization-preload";
import { expect, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { CloudRuntime } from "@k2b/cloud/contracts";
import { type AuthContext, auth } from "@k2b/cloud/server";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../../../scripts/fixtures/caller-address";
import { meterSql } from "../../../../../scripts/fixtures/sql-meter";
import { ssr } from "../../config";
import { notebooksService } from "../../service";
import { reindexLinks } from "../../service/links";
import "./_components/detail/ssr-test-plugin";

const { default: handler } = await import("./page");
const suite = suiteFor("database", "nats", "valkey");
const timestamp = "2026-10-01T08:00:00.000Z";
const identity = () => ({ id: crypto.randomUUID(), shortId: testShortId() });

/**
 * What the notebook page costs (page audit 27.11.): the statements of one SSR load of a note, measured and pinned. The
 * selected note is read once for the request, the reads after it run in one parallel step, and the cost does not grow
 * with the notebook: twelve more notes, tags and attachments add no statement.
 */
const NOTE_PAGE_STATEMENTS = 24;

suite("the notebook page's SSR load", () => {
  test("a note opens with a fixed number of statements, the note read once, whatever the notebook holds", async () => {
    const notebook = identity();
    const userId = crypto.randomUUID();
    const accessId = crypto.randomUUID();
    const notes = Array.from({ length: 14 }, (_, index) => ({ ...identity(), title: `Seite ${index + 1}` }));
    const [open, linked] = notes;
    const body = `# ${open!.title}\n\nSiehe [${linked!.title}](note://${linked!.shortId}) #lager #team`;
    try {
      await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name)
        VALUES (${userId}::uuid, ${`page-load-${userId}`}, 'local', 'user', 'Ada Renz')`;
      await sql`INSERT INTO notebooks.notebooks (id, short_id, name, created_at, updated_at)
        VALUES (${notebook.id}::uuid, ${notebook.shortId}, 'Werkstatt', ${timestamp}::timestamptz, ${timestamp}::timestamptz)`;
      for (const note of notes)
        await sql`INSERT INTO notebooks.notes (id, short_id, notebook_id, title, content_md, created_at, updated_at)
          VALUES (${note.id}::uuid, ${note.shortId}, ${notebook.id}::uuid, ${note.title},
            ${note === open ? body : `# ${note.title}`}, ${timestamp}::timestamptz, ${timestamp}::timestamptz)`;
      await reindexLinks(open!.id, body);
      await sql`INSERT INTO auth.access (id, user_id, permission) VALUES (${accessId}::uuid, ${userId}::uuid, 'write')`;
      await sql`INSERT INTO notebooks.notebook_access (notebook_id, access_id) VALUES (${notebook.id}::uuid, ${accessId}::uuid)`;

      const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
      app.use("*", async (c, next) => {
        c.set("runtime", { apps: [] });
        await next();
      });
      app.route(
        "/app/notebooks",
        new Hono<AuthContext>().get(
          "/:id/:noteId",
          auth.requireRole("authenticated", ssr.access),
          auth.requireUser(ssr.access),
          ...handler,
        ),
      );
      const token = await createTestSession(userId);
      const headers = { cookie: `session_token=${token}`, "accept-language": "de", "x-forwarded-for": uniqueCallerAddress() };
      const path = `/app/notebooks/${notebook.shortId}/${open!.shortId}`;
      // one warm load first: the session and the configuration are read once per process, not per page
      expect((await app.request(path, { headers })).status).toBe(200);

      const reads = spyOn(notebooksService.note, "getByShortId");
      const meter = await meterSql();
      try {
        const statements = await meter.during(async () => {
          const response = await app.request(path, { headers });
          expect(response.status).toBe(200);
          expect(await response.text()).toContain(open!.title);
        });
        // the selected note is read once for the request
        expect(reads).toHaveBeenCalledTimes(1);
        expect(statements.length).toBe(NOTE_PAGE_STATEMENTS);
      } finally {
        reads.mockRestore();
        await meter.close();
      }
    } finally {
      await sql`DELETE FROM notebooks.notebooks WHERE id = ${notebook.id}::uuid`;
      await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  }, 30_000);
});
