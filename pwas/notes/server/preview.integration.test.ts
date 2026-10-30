import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import * as Y from "yjs";
import { createDisposableDatabase, databaseSuite } from "../../../scripts/fixtures/test-infra";
import { createNotesApp } from "./app";
import { migrate } from "./database";
import { linkMetadata, renderPreview } from "./preview";
import { NotesService } from "./service";
import { NotesStore } from "./store";
import { mountWebsite } from "./website";

const origin = "https://notes.example.test";
const index = '<html><head><title>k2b notes</title><!--og--></head><body><div id="app"></div></body></html>';
const content =
  '# A & "quoted" title\n\nText with <img src=x onerror=alert(1)> & symbols.\n\n![remote](https://invalid.example.test/private.png)\n\n| Month | Total |\n| --- | --- |\n| Jan | 12 |\n| Feb | 20 |';

test("metadata escapes text and uses the read capability for both preview images", () => {
  const html = linkMetadata(index, "edit-link", "read-link", origin, content);
  expect(html).toContain('og:url" content="https://notes.example.test/p/edit-link"');
  expect(html).toContain('og:image" content="https://notes.example.test/p/read-link/preview.png"');
  expect(html).toContain("A &amp; &quot;quoted&quot; title");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("onerror");
  expect(html.match(/<title>/g)?.length).toBe(1);
});

test("renderer creates a local 1200 by 630 PNG without fetching note URLs", async () => {
  const original = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = Object.assign(
    () => {
      fetched = true;
      throw new Error("unexpected_network");
    },
    { preconnect: original.preconnect },
  );
  try {
    const png = await renderPreview(content);
    const bytes = Buffer.from(png);
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    expect(bytes.readUInt32BE(16)).toBe(1200);
    expect(bytes.readUInt32BE(20)).toBe(630);
    expect(fetched).toBe(false);
  } finally {
    globalThis.fetch = original;
  }
});

databaseSuite()("Notes static website and previews", () => {
  let database: Awaited<ReturnType<typeof createDisposableDatabase>>;
  let db: SQL;
  let directory: string;
  let service: NotesService;
  let app: ReturnType<typeof createNotesApp>;
  let links: { readId: string; editId: string };
  beforeAll(async () => {
    database = await createDisposableDatabase("notes_preview");
    db = new SQL(database.url);
    await migrate(db);
    directory = await mkdtemp(join(tmpdir(), "notes-preview-"));
    await Bun.write(join(directory, "index.html"), index);
    await Bun.write(join(directory, "app.js"), "export const app = true;");
    await Bun.write(join(directory, "private.map"), "source map");
  });
  beforeEach(async () => {
    setSystemTime(new Date("2026-10-30T12:00:00Z"));
    service = new NotesService(new NotesStore(db, 1024 ** 3), { storageBytes: 1024 ** 3, maxConnections: 50, maxOpenPads: 5 });
    await service.start();
    const doc = new Y.Doc();
    doc.clientID = 1;
    doc.getText("text").insert(0, content);
    links = await service.create(Y.encodeStateAsUpdate(doc), "192.0.2.1");
    doc.destroy();
    app = createNotesApp(async () => true, service, { origin });
    await mountWebsite(app, service, { origin }, directory, 5);
  });
  afterEach(async () => {
    await service.stop();
    await db`TRUNCATE pads CASCADE`;
  });
  afterAll(async () => {
    setSystemTime();
    await db.close();
    await database.drop();
    await rm(directory, { recursive: true, force: true });
  });
  test("GET and HEAD serve escaped HTML and checked assets without database mutations", async () => {
    const [before] = await db`SELECT row_to_json(pads)::text AS state FROM pads WHERE read_id=${links.readId}`;
    for (const token of [links.readId, links.editId]) {
      const response = await app.request(`/p/${token}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(`${origin}/p/${links.readId}/preview.png`);
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    }
    const head = await app.request(`/p/${links.readId}/preview.png`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const first = await app.request(`/p/${links.readId}/preview.png`);
    const second = await app.request(`/p/${links.readId}/preview.png`);
    expect(first.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(new Uint8Array(await second.arrayBuffer()));
    expect((await app.request(`/p/${links.editId}/preview.png`)).status).toBe(404);
    const [after] = await db`SELECT row_to_json(pads)::text AS state FROM pads WHERE read_id=${links.readId}`;
    expect(after).toEqual(before);
    const [cache] = await db`SELECT count(*)::int AS count FROM pad_previews`;
    expect(cache.count).toBe(0);
    expect((await app.request("/app.js")).headers.get("Content-Type")).toContain("javascript");
    expect((await app.request("/n/local-id")).status).toBe(200);
    expect((await app.request("/private.map")).status).toBe(404);
    expect((await app.request("/api/unknown")).status).toBe(404);
    expect((await app.request("/missing.js")).status).toBe(404);
  });
  test("cached images are inaccessible after deletion, including requests with the edit capability", async () => {
    expect((await app.request(`/p/${links.readId}/preview.png`)).status).toBe(200);
    await service.remove(links.editId);
    const response = await app.request(`/p/${links.readId}`);
    expect(response.status).toBe(410);
    expect(await response.text()).not.toContain("og:title");
    expect((await app.request(`/p/${links.readId}/preview.png`)).status).toBe(410);
  });
});
