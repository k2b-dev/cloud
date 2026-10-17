import { suiteFor } from "../../../../../scripts/fixtures/test-infra";
import "../../../../../scripts/fixtures/authorization-preload";
import { expect, test } from "bun:test";
import type { CloudRuntime } from "@k2b/cloud/contracts";
import { type AuthContext, auth } from "@k2b/cloud/server";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { Hono } from "hono";
import { fromJSON } from "seroval";
import { uniqueCallerAddress } from "../../../../../scripts/fixtures/caller-address";
import { selectHtml } from "../../../../../tests/fixtures/select-html";
import api from "../../api";
import { ssr } from "../../config";
import { type NoteGraph, reindexLinks } from "../../service/links";
import "./_components/detail/ssr-test-plugin";

const { default: handler } = await import("./page");
const suite = suiteFor("database", "nats", "valkey");
const timestamp = "2026-10-01T08:00:00.000Z";
const identity = () => ({ id: crypto.randomUUID(), shortId: crypto.randomUUID().replaceAll("-", "").slice(0, 6) });

suite("Notebook graph read access on SSR and REST", () => {
  test("readers see only their notebook's nodes and internal edges; no grant denies both surfaces", async () => {
    const a = identity();
    const b = identity();
    const a1 = { ...identity(), title: "Graph access A one" };
    const a2 = { ...identity(), title: "Graph access A two" };
    const b1 = { ...identity(), title: "Hidden graph access B one" };
    const readerId = crypto.randomUUID();
    const strangerId = crypto.randomUUID();
    const accessId = crypto.randomUUID();
    const bodyA = `# ${a1.title}\n\n[Inside](note://${a2.shortId})\n\n[Outside](note://${b1.shortId})\n\nBody must stay out of the graph.`;
    const bodyB = `# ${b1.title}\n\n[Outside](note://${a1.shortId})`;
    try {
      await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name) VALUES
        (${readerId}::uuid, ${`graph-reader-${readerId}`}, 'local', 'user', 'Graph reader'),
        (${strangerId}::uuid, ${`graph-stranger-${strangerId}`}, 'local', 'user', 'Graph stranger')`;
      await sql`INSERT INTO notebooks.notebooks (id, short_id, name, created_at, updated_at) VALUES
        (${a.id}::uuid, ${a.shortId}, 'Graph A', ${timestamp}::timestamptz, ${timestamp}::timestamptz),
        (${b.id}::uuid, ${b.shortId}, 'Graph B', ${timestamp}::timestamptz, ${timestamp}::timestamptz)`;
      for (const [notebook, note, body] of [
        [a, a1, bodyA],
        [a, a2, `# ${a2.title}`],
        [b, b1, bodyB],
      ] as const) {
        await sql`INSERT INTO notebooks.notes (id, short_id, notebook_id, title, content_md, created_at, updated_at) VALUES
          (${note.id}::uuid, ${note.shortId}, ${notebook.id}::uuid, ${note.title}, ${body}, ${timestamp}::timestamptz, ${timestamp}::timestamptz)`;
      }
      await reindexLinks(a1.id, bodyA);
      await reindexLinks(b1.id, bodyB);
      // Ensure the scoping assertions exercise actual cross-notebook links.
      const cross = await sql`SELECT * FROM notebooks.note_links WHERE source_note_id = ${b1.id}::uuid OR target_note_id = ${b1.id}::uuid`;
      expect(cross).toHaveLength(2);
      await sql`INSERT INTO auth.access (id, user_id, permission) VALUES (${accessId}::uuid, ${readerId}::uuid, 'read')`;
      await sql`INSERT INTO notebooks.notebook_access (notebook_id, access_id) VALUES (${a.id}::uuid, ${accessId}::uuid)`;

      const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
      app.use("*", async (c, next) => {
        c.set("runtime", { apps: [] });
        await next();
      });
      app.route(
        "/app/notebooks",
        new Hono<AuthContext>().get("/:id", auth.requireRole("authenticated", ssr.access), auth.requireUser(ssr.access), ...handler),
      );
      const headers = (token: string) => ({
        cookie: `session_token=${token}`,
        "accept-language": "en",
        "x-forwarded-for": uniqueCallerAddress(),
      });
      const reader = await createTestSession(readerId);
      const stranger = await createTestSession(strangerId);
      const response = await app.request(`/app/notebooks/${a.shortId}?mode=graph&note=${a1.shortId}`, { headers: headers(reader) });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("notebook-book-workspace");
      expect(html).not.toContain(b1.title);
      expect(html).not.toContain(b1.shortId);
      expect(html).not.toContain("Body must stay out of the graph.");
      const [island] = await selectHtml(html, 'solid-island[data-file="NotebookGraph.island.tsx"]');
      expect(island).toBeDefined();
      const serialized = island!.attributes["data-props"]!;
      const props = fromJSON<{ graph: NoteGraph; selectedNoteId: string; from: string }>(
        JSON.parse(serialized.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")),
      );
      expect(props.selectedNoteId).toBe(a1.shortId);
      expect(props.from).toBe("book");
      expect(props.graph.nodes.map((node) => node.title).sort()).toEqual([a1.title, a2.title].sort());
      expect(props.graph.nodes.map((node) => node.id).sort()).toEqual([a1.shortId, a2.shortId].sort());
      expect(props.graph.edges).toEqual([{ source: a1.shortId, target: a2.shortId }]);

      const graphResponse = await api.request(`/${a.shortId}/graph`, { headers: headers(reader) });
      expect(graphResponse.status).toBe(200);
      expect(await graphResponse.json()).toEqual({ data: props.graph });
      expect((await app.request(`/app/notebooks/${a.shortId}?mode=graph&note=${a1.shortId}`, { headers: headers(stranger) })).status).toBe(
        403,
      );
      expect((await api.request(`/${a.shortId}/graph`, { headers: headers(stranger) })).status).toBe(403);
    } finally {
      await sql`DELETE FROM notebooks.notebooks WHERE id IN (${a.id}::uuid, ${b.id}::uuid)`;
      await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id IN (${readerId}::uuid, ${strangerId}::uuid)`;
    }
  }, 30_000);
});
