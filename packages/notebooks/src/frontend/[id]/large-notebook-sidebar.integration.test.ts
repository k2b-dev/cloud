import { suiteFor } from "../../../../../scripts/fixtures/test-infra";
import "../../../../../scripts/fixtures/authorization-preload";
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { CloudRuntime } from "@k2b/cloud/contracts";
import { type AuthContext, auth } from "@k2b/cloud/server";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../../../scripts/fixtures/caller-address";
import api from "../../api";
import { ssr } from "../../config";
import { migrate } from "../../migrate";
import { type InsertedFixtureNotebook, insertFixtureNotebook, removeFixtureNotebooks } from "../../service/large-notebook.test-fixture";
import "./_components/detail/ssr-test-plugin";

const { default: handler } = await import("./page");
const suite = suiteFor("database", "nats", "valkey");

/**
 * The guard for large notebooks: the same page of a 13-page and a 20,000-page notebook costs about the same. A
 * path that grows with the notebook, such as the whole tree in the page or in a refresh, fails here.
 */
suite("A 20,000-page notebook opens like a small one", () => {
  const readerId = crypto.randomUUID();
  const accessIds: string[] = [];
  let small: InsertedFixtureNotebook;
  let large: InsertedFixtureNotebook;
  let session: string;
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("runtime", { apps: [] });
    await next();
  });
  app.route(
    "/app/notebooks",
    new Hono<AuthContext>().get(
      "/:id/notes/:noteId",
      auth.requireRole("authenticated", ssr.access),
      auth.requireUser(ssr.access),
      ...handler,
    ),
  );
  const headers = () => ({ cookie: `session_token=${session}`, "accept-language": "en", "x-forwarded-for": uniqueCallerAddress() });

  beforeAll(async () => {
    await migrate();
    [small, large] = await Promise.all([insertFixtureNotebook("small"), insertFixtureNotebook("large")]);
    await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name) VALUES
      (${readerId}::uuid, ${`large-reader-${readerId}`}, 'local', 'user', 'Large reader')`;
    for (const notebook of [small, large]) {
      const accessId = crypto.randomUUID();
      accessIds.push(accessId);
      await sql`INSERT INTO auth.access (id, user_id, permission) VALUES (${accessId}::uuid, ${readerId}::uuid, 'write')`;
      await sql`INSERT INTO notebooks.notebook_access (notebook_id, access_id) VALUES (${notebook.id}::uuid, ${accessId}::uuid)`;
    }
    session = await createTestSession(readerId);
  }, 120_000);

  afterAll(async () => {
    await removeFixtureNotebooks();
    if (accessIds.length > 0) await sql`DELETE FROM auth.access WHERE id = ANY(${sql.array(accessIds, "UUID")})`;
    await sql`DELETE FROM auth.users WHERE id = ${readerId}::uuid`;
  });

  /** Median time and size of one request, after one warm-up. */
  const measure = async (request: () => Promise<Response> | Response) => {
    await (await request()).arrayBuffer();
    const times: number[] = [];
    let bytes = 0;
    for (let run = 0; run < 3; run++) {
      const started = performance.now();
      const response = await request();
      expect(response.status).toBe(200);
      bytes = (await response.arrayBuffer()).byteLength;
      times.push(performance.now() - started);
    }
    return { ms: Math.round(times.sort((a, b) => a - b)[1]!), bytes };
  };

  const paths = (notebook: InsertedFixtureNotebook) => ({
    "open a page in the largest folder": () =>
      app.request(`/app/notebooks/${notebook.shortId}/notes/${notebook.page.shortId}`, { headers: headers() }),
    "open the largest folder": () =>
      app.request(`/app/notebooks/${notebook.shortId}/notes/${notebook.folder.shortId}`, { headers: headers() }),
    "workspace refresh": () => api.request(`/${notebook.shortId}/workspace-state`, { headers: headers() }),
    "open the largest folder in the sidebar": () =>
      api.request(`/${notebook.shortId}/tree/levels?levels=${notebook.folder.shortId}:0:100`, { headers: headers() }),
    "reveal a deep page": () => api.request(`/${notebook.shortId}/tree/levels?reveal=${notebook.page.shortId}`, { headers: headers() }),
    "recently changed": () => api.request(`/${notebook.shortId}/tree/list?view=recents`, { headers: headers() }),
    "notes with a tag": () => api.request(`/${notebook.shortId}/tree/list?view=tag&tag=project`, { headers: headers() }),
  });

  test("every main sidebar path stays the size and about the speed of a 13-page notebook", async () => {
    const report: Record<string, { small: { ms: number; bytes: number }; large: { ms: number; bytes: number } }> = {};
    const smallPaths = paths(small);
    const largePaths = paths(large);
    for (const name of Object.keys(smallPaths) as (keyof typeof smallPaths)[]) {
      report[name] = { small: await measure(smallPaths[name]), large: await measure(largePaths[name]) };
    }
    console.info(JSON.stringify(report, null, 2));
    for (const [name, { small: base, large: big }] of Object.entries(report)) {
      // A page of 100 sidebar rows is the most a level adds; the whole tree would be megabytes.
      expect(big.bytes, name).toBeLessThan(Math.max(base.bytes * 3, base.bytes + 120_000));
      // Generous, so a busy runner does not fail it; a path that reads the whole notebook takes seconds here.
      expect(big.ms, name).toBeLessThan(base.ms * 5 + 400);
    }
  }, 120_000);

  test("the page carries only the levels on the way to the open note, a window of each", async () => {
    const html = await (await app.request(`/app/notebooks/${large.shortId}/notes/${large.page.shortId}`, { headers: headers() })).text();
    const rows = html.match(/role="treeitem"/g)?.length ?? 0;
    expect(rows).toBeLessThan(500);
    expect(html).toContain(large.page.shortId);
    // Only the open note's Markdown reaches the page, never the notebook's.
    expect((html.match(/contentMd/g) ?? []).length).toBeLessThan(10);
  }, 60_000);
});
