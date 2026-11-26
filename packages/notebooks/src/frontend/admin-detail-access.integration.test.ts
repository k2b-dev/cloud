import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { CloudRuntime } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import { migrate } from "../migrate";
import { notebooksService } from "../service";
import "./[id]/_components/detail/ssr-test-plugin";

const { adminPages } = await import("./index");
const suite = suiteFor("database", "nats", "valkey");

/**
 * The open notebook in the administration names notes only through the reader's own access to that notebook, as every
 * reader of Notebooks: the administration's role opens the page, not the notes. A Cloud administrator without a grant
 * sees the figures and no note titles; one with a grant sees them; anyone else gets no page.
 */
suite("The administration's open notebook names notes only through the reader's access", () => {
  const cloudAdmin = crypto.randomUUID();
  const memberAdmin = crypto.randomUUID();
  const notebookA = { id: crypto.randomUUID(), shortId: testShortId() };
  const notebookB = { id: crypto.randomUUID(), shortId: testShortId() };
  const noteA = crypto.randomUUID();
  const noteB = crypto.randomUUID();
  const titleA = `Admin detail A ${crypto.randomUUID().slice(0, 8)}`;
  const titleB = `Admin detail B ${crypto.randomUUID().slice(0, 8)}`;
  const accessIds = [crypto.randomUUID(), crypto.randomUUID()];
  const sessions: Record<string, string> = {};
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("runtime", { apps: [] });
    await next();
  });
  app.route("/admin/notebooks", adminPages);
  const page = (who: string, open: string) =>
    app.request(`/admin/notebooks?open=${open}`, {
      headers: { cookie: `session_token=${sessions[who]}`, "accept-language": "en", "x-forwarded-for": uniqueCallerAddress() },
    });

  beforeAll(async () => {
    await migrate();
    await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name, admin) VALUES
      (${cloudAdmin}::uuid, ${`admin-detail-${cloudAdmin}`}, 'local', 'user', 'Cloud Admin', true),
      (${memberAdmin}::uuid, ${`admin-detail-${memberAdmin}`}, 'local', 'user', 'Member Admin', false)`;
    for (const [notebook, title, note] of [
      [notebookA, titleA, noteA],
      [notebookB, titleB, noteB],
    ] as const) {
      await sql`INSERT INTO notebooks.notebooks (id, short_id, name) VALUES (${notebook.id}::uuid, ${notebook.shortId}, ${`Notebook ${title.slice(-8)}`})`;
      await sql`INSERT INTO notebooks.notes (id, short_id, notebook_id, title) VALUES (${note}::uuid, ${testShortId()}, ${notebook.id}::uuid, ${title})`;
      await sql`INSERT INTO notebooks.activity_events (notebook_id, note_id, actor_kind, actor_id, action)
        VALUES (${notebook.id}::uuid, ${note}::uuid, 'user', ${memberAdmin}::uuid, 'note.edited')`;
    }
    // the member administers A; the Cloud administrator reads A; nobody holds a grant on B
    await sql`INSERT INTO auth.access (id, user_id, permission) VALUES
      (${accessIds[0]!}::uuid, ${memberAdmin}::uuid, 'admin'), (${accessIds[1]!}::uuid, ${cloudAdmin}::uuid, 'read')`;
    await sql`INSERT INTO notebooks.notebook_access (notebook_id, access_id) VALUES
      (${notebookA.id}::uuid, ${accessIds[0]!}::uuid), (${notebookA.id}::uuid, ${accessIds[1]!}::uuid)`;
    sessions.cloudAdmin = await createTestSession(cloudAdmin);
    sessions.memberAdmin = await createTestSession(memberAdmin);
  }, 120_000);

  afterAll(async () => {
    await sql`DELETE FROM notebooks.notebooks WHERE id = ANY(ARRAY[${notebookA.id}::uuid, ${notebookB.id}::uuid])`;
    await sql`DELETE FROM auth.access WHERE id = ANY(ARRAY[${accessIds[0]!}::uuid, ${accessIds[1]!}::uuid])`;
    await sql`DELETE FROM auth.users WHERE id = ANY(ARRAY[${cloudAdmin}::uuid, ${memberAdmin}::uuid])`;
  });

  test("a Cloud administrator sees the note titles of a notebook they can read", async () => {
    const response = await page("cloudAdmin", notebookA.shortId);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(titleA);
  }, 60_000);

  test("a Cloud administrator without a grant sees the notebook's figures, no note titles", async () => {
    const response = await page("cloudAdmin", notebookB.shortId);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`Notebook ${titleB.slice(-8)}`);
    expect(html).not.toContain(titleB);
    expect(html).toContain("Only members of this notebook see its history");
  }, 60_000);

  test("anyone else gets no administration page and no titles, also for a notebook they administer", async () => {
    for (const open of [notebookA.shortId, notebookB.shortId]) {
      const response = await page("memberAdmin", open);
      expect(response.status).toBe(403);
      const html = await response.text();
      expect(html).not.toContain(titleA);
      expect(html).not.toContain(titleB);
    }
  }, 60_000);

  test("a member who administers notebook A reads nothing of notebook B through the same service", async () => {
    const member = { userId: memberAdmin, serviceAccountId: null };
    expect(await notebooksService.notebook.permission.get({ notebookId: notebookB.id, ...member })).toBe("none");
    expect((await notebooksService.activity.list({ ...member, notebookId: notebookB.id })).items).toEqual([]);
    expect(await notebooksService.notebook.permission.get({ notebookId: notebookA.id, ...member })).toBe("admin");
    expect((await notebooksService.activity.list({ ...member, notebookId: notebookA.id })).items.map((item) => item.note?.title)).toEqual([
      titleA,
    ]);
  }, 60_000);
});
