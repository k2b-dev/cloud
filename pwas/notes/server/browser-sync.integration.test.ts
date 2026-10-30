import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { SQL } from "bun";
import type { Browser, BrowserContext, Page } from "playwright";
import * as Y from "yjs";
import { launchBrowser, pageErrors } from "../../../packages/ui/test/browser";
import { createDisposableDatabase, databaseSuite } from "../../../scripts/fixtures/test-infra";
import { updateFrame } from "../protocol";
import { migrate } from "./database";
import { serveNotes } from "./runtime";
import { NotesStore } from "./store";

const NOW = new Date("2026-10-30T12:00:00Z");

databaseSuite()("Notes browser provider against durable server", () => {
  let database: Awaited<ReturnType<typeof createDisposableDatabase>>;
  let runtime: Awaited<ReturnType<typeof serveNotes>>;
  let browser: Browser;
  let bundle: string;
  const contexts: BrowserContext[] = [];
  const errors: string[][] = [];
  const options = {
    storageBytes: 1024 ** 3,
    maxConnections: 20,
    maxOpenPads: 10,
    origin: "http://127.0.0.1",
    hostname: "127.0.0.1",
    port: 0,
  };
  const start = async () => {
    const db = new SQL(database.url);
    try {
      runtime = await serveNotes(db, options);
    } catch (error) {
      await db.close();
      throw error;
    }
    options.origin = runtime.server.url.origin;
    options.port = runtime.server.port ?? 0;
    runtime.app.get("/client.js", (c) => c.body(bundle, 200, { "Content-Type": "text/javascript" }));
    runtime.app.get("/client", (c) => c.html('<!doctype html><script type="module" src="/client.js"></script>'));
  };
  beforeAll(async () => {
    setSystemTime(NOW);
    database = await createDisposableDatabase("notes_browser_sync");
    const db = new SQL(database.url);
    try {
      await migrate(db);
    } finally {
      await db.close();
    }
    const built = await Bun.build({
      entrypoints: [new URL("./browser-client.fixture.ts", import.meta.url).pathname],
      target: "browser",
      conditions: ["browser"],
    });
    if (!built.success) throw new AggregateError(built.logs, "Notes browser fixture build failed");
    const entry = built.outputs.find((output) => output.kind === "entry-point");
    if (!entry) throw new Error("Notes browser fixture entry missing");
    bundle = await entry.text();
    await start();
    browser = await launchBrowser();
  }, 30_000);
  afterAll(async () => {
    try {
      await Promise.all(contexts.map((context) => context.close()));
      await browser?.close();
    } finally {
      await runtime?.stop();
      await database?.drop();
      setSystemTime();
    }
  });
  const open = async (link: string, client: number, role = "edit") => {
    const context = await browser.newContext({ serviceWorkers: "block" });
    contexts.push(context);
    const page = await context.newPage();
    errors.push(pageErrors(page));
    page.setDefaultTimeout(5_000);
    await page.clock.setFixedTime(NOW);
    await page.goto(`${options.origin}/client?link=${link}&client=${client}&role=${role}`);
    await live(page);
    return { page, context };
  };
  const live = (page: Page) => page.waitForFunction(() => window.notesClient?.status() === "live" && window.notesClient.pending() === 0);
  const has = (page: Page, values: string[]) =>
    page.waitForFunction((values) => values.every((value) => window.notesClient?.text().includes(value)), values);

  test("two open browsers merge offline edits, reconnect after restart and preserve read-only access", async () => {
    const initial = new Y.Doc();
    initial.clientID = 10;
    initial.getText("text").insert(0, "initial");
    const shared = await runtime.service.create(Y.encodeStateAsUpdate(initial), "192.0.2.1");
    initial.destroy();
    const alice = await open(shared.editId, 101);
    const bob = await open(shared.editId, 102);
    await has(alice.page, ["initial"]);
    await has(bob.page, ["initial"]);
    await alice.context.setOffline(true);
    await alice.page.waitForFunction(() => window.notesClient.status() === "offline");
    await Promise.all([
      alice.page.evaluate(() => window.notesClient.insert(" Alice")),
      bob.page.evaluate(() => window.notesClient.insert(" Bob")),
    ]);
    await live(bob.page);
    expect((await runtime.service.read(shared.readId)).content).not.toContain("Alice");
    await alice.context.setOffline(false);
    await Promise.all([has(alice.page, ["Alice", "Bob"]), has(bob.page, ["Alice", "Bob"])]);
    await Promise.all([live(alice.page), live(bob.page)]);
    const merged = await alice.page.evaluate(() => window.notesClient.text());
    expect(await bob.page.evaluate(() => window.notesClient.text())).toBe(merged);
    expect((await runtime.service.read(shared.readId)).content).toBe(merged);

    await runtime.stop();
    await Promise.all([
      alice.page.waitForFunction(() => window.notesClient.status() === "offline"),
      bob.page.waitForFunction(() => window.notesClient.status() === "offline"),
    ]);
    // Verify Postgres before either browser can repopulate an empty successor.
    const durable = new SQL(database.url);
    try {
      const restored = await new NotesStore(durable, options.storageBytes).load(shared.readId);
      try {
        expect(restored.doc.getText("text").toString()).toBe(merged);
      } finally {
        restored.doc.destroy();
      }
    } finally {
      await durable.close();
    }
    await start();
    await Promise.all([live(alice.page), live(bob.page)]);
    await bob.page.evaluate(() => window.notesClient.insert(" after restart"));
    await has(alice.page, ["after restart"]);
    await live(bob.page);
    const saved = await alice.page.evaluate(() => window.notesClient.text());
    expect((await runtime.service.read(shared.readId)).content).toBe(saved);

    const reader = await open(shared.readId, 103, "read");
    await has(reader.page, ["Alice", "Bob", "after restart"]);
    await reader.page.evaluate(() => window.notesClient.insert(" private reader edit"));
    expect(await reader.page.evaluate(() => window.notesClient.pending())).toBe(0);
    // Bypass the provider's client-side gate and wait for the server's refusal.
    const bytes = Array.from(updateFrame("readonly-probe", new Uint8Array(await reader.page.evaluate(() => window.notesClient.state()))));
    const closed = await reader.page.evaluate(
      ({ link, bytes }) =>
        new Promise<{ code: number; reason: string }>((resolve, reject) => {
          const socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/api/pads/${link}/ws`);
          socket.addEventListener("open", () => socket.send(new Uint8Array(bytes)), { once: true });
          socket.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }), { once: true });
          socket.addEventListener("error", () => reject(new Error("read-only probe socket failed")), { once: true });
        }),
      { link: shared.readId, bytes },
    );
    expect(closed).toEqual({ code: 1008, reason: "read_only" });
    expect((await runtime.service.read(shared.readId)).content).toBe(saved);
    expect(await bob.page.evaluate(() => window.notesClient.text())).toBe(saved);
    expect(errors.flat()).toEqual([]);
  }, 20_000);
});
