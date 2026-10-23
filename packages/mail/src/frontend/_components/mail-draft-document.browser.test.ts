import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTrustedTextAwareness } from "@k2b/cloud/shared-text";
import { encoding } from "@k2b/stdlib";
import type { ServerWebSocket } from "bun";
import type { Browser, Page } from "playwright";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { launchBrowser, settled } from "../../../../ui/test/browser";
import type { DraftEditableContent, MailDraft } from "../../contracts";
import { createDraftDocument, DRAFT_BODY, readDraftDocument, writeLocalDraftHeaders } from "../../lib/draft-document";
import { mailDraftDocumentRequestSchema } from "../../lib/draft-document-protocol";
import type {} from "./mail-draft-document.browser-harness";

const base: DraftEditableContent = {
  senderIdentityId: "Send01",
  signatureTemplateId: null,
  to: [{ name: "Ada", address: "ada@example.test" }],
  cc: [],
  bcc: [],
  subject: "Offer",
  body: "Hello\n\n| Item | Cost |\n| --- | --- |\n| Pen | 4 |",
  format: "markdown",
  priority: "normal",
  requestDeliveryReceipt: false,
  requestReadReceipt: false,
};
const now = "2026-10-04T10:00:00.000Z";
const draft = (): MailDraft => ({
  ...base,
  signatureTemplateId: null,
  id: "Draft1",
  mailboxId: "Box001",
  conversationId: null,
  intent: "new",
  sourceMessageId: null,
  derivedFromMessageId: null,
  derivationKind: null,
  attachments: [],
  createdBy: { kind: "user", userId: "Usr001" },
  lastEditedBy: { kind: "user", userId: "Usr001" },
  lastEditedByDisplayName: "Ada",
  recoveryCopyCount: 0,
  revision,
  editMode: "shared",
  generation,
  state: lifecycle,
  deliveryClass: "normal",
  createdAt: now,
  updatedAt: now,
});
let document = createDraftDocument(base),
  durable = Y.encodeStateAsUpdate(document);
let generation = "1";
let revision = 1,
  seq = 1,
  saveFails = false,
  lifecycle: MailDraft["state"] = "draft",
  denied = false;
let frozen: Uint8Array | null = null;
const requests: string[] = [];
const recoveries: { generation: string; clientId: string; state: string }[] = [];
const sockets = new Set<ServerWebSocket<{ document: boolean }>>();
const cursor = () => `s6t.fixture.${seq}`;
const snapshot = (state: Uint8Array) => {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    return { state: encoding.toBase64(state), cursor: cursor(), content: readDraftDocument(doc) };
  } finally {
    doc.destroy();
  }
};
const session = () => ({
  generation,
  revision,
  lifecycle,
  historyComplete: true,
  fresh: snapshot(Y.encodeStateAsUpdate(document)),
  durable: snapshot(durable),
  frozen: frozen && generation === "1" ? { generation: "1", revision, cursor: cursor(), state: encoding.toBase64(frozen) } : null,
});
const packet = (socket: ServerWebSocket<{ document: boolean }>, type: string, payload: unknown) =>
  socket.send(JSON.stringify({ type, payload }));
const publish = (bytes: Uint8Array) => {
  seq++;
  for (const socket of sockets)
    packet(socket, "syncPush", {
      docId: "Draft1",
      generation: "1",
      updates: [{ generation: "1", payload: encoding.toBase64(bytes), cursor: cursor() }],
    });
};
const buildHarness = async () => {
  const ui = new URL("../../../../ui/", import.meta.url).pathname;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./mail-draft-document.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "mail-shared",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Shared Mail browser build failed");
  return build.outputs[0]!.text();
};
const harness = await buildHarness();
const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../../cloud/", import.meta.url).pathname))).default;
const cssBuild = await Bun.build({ entrypoints: [new URL("../../../../../styles.css", import.meta.url).pathname], plugins: [tailwind] });
if (!cssBuild.success) throw new AggregateError(cssBuild.logs, "Mail shared CSS failed");
const css = await cssBuild.outputs[0]!.text();
const server = Bun.serve<{ document: boolean }>({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request, server) => {
    const path = new URL(request.url).pathname;
    requests.push(`${request.method} ${path}`);
    if (path.endsWith("/socket") || path.includes("/live")) {
      if (server.upgrade(request, { data: { document: path.endsWith("/document/socket") } })) return;
      return new Response(null, { status: 400 });
    }
    if (path === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript" } });
    if (path === "/styles.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
    if (path === "/fixture/draft") return Response.json(draft());
    if (denied && path.includes("/document")) return Response.json({ message: "Zugriff entzogen" }, { status: 403 });
    if (path.endsWith("/document")) return Response.json(session());
    if (path.endsWith("/drafts/Draft1")) return Response.json(draft());
    if (path.endsWith("/snapshot")) {
      if (saveFails) return Response.json({ message: "Dauerhafte Speicherung fehlgeschlagen" }, { status: 503 });
      const body = await request.json();
      if (body.generation !== generation) return new Response(null, { status: 409 });
      durable = Y.encodeStateAsUpdate(document);
      revision++;
      return Response.json({ generation, revision, status: "saved", durable: snapshot(durable) });
    }
    if (path.endsWith("/rest")) {
      const body = await request.json();
      recoveries.push(body);
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, encoding.fromBase64(body.state));
        if (frozen && JSON.stringify(readDraftDocument(doc)) === JSON.stringify(snapshot(frozen).content))
          return Response.json({ status: "unchanged", durableSourceState: encoding.toBase64(frozen) });
        return Response.json({
          status: "recovered",
          draft: { ...draft(), ...readDraftDocument(doc), id: "Rest01", state: "draft" },
          durableSourceState: body.state,
        });
      } finally {
        doc.destroy();
      }
    }
    return new Response(
      '<!doctype html><html class="light"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body class="k2b-ui"><div id="root" style="height:90vh"></div><script src="/harness.js"></script></body></html>',
      { headers: { "Content-Type": "text/html" } },
    );
  },
  websocket: {
    open(socket) {
      if (socket.data.document) sockets.add(socket);
    },
    message(socket, data) {
      if (!socket.data.document) return;
      const parsed = mailDraftDocumentRequestSchema.safeParse(JSON.parse(String(data)));
      if (!parsed.success) throw new Error(parsed.error.message);
      const { type, payload } = parsed.data;
      if (type === "replayRequest") {
        packet(socket, "syncPush", {
          docId: "Draft1",
          generation: "1",
          snapshot: true,
          updates: [{ payload: encoding.toBase64(durable), generation: "1", cursor: cursor() }],
        });
        packet(socket, "syncPush", {
          docId: "Draft1",
          generation: "1",
          updates: [{ payload: encoding.toBase64(Y.encodeStateAsUpdate(document)), generation: "1", cursor: cursor() }],
        });
        packet(socket, "replayReady", { docId: "Draft1", generation: "1", cursor: cursor(), peerId: "fixture" });
      } else if (type === "syncPublish") {
        const bytes = encoding.fromBase64(payload.payload);
        Y.applyUpdate(document, bytes);
        publish(bytes);
      }
    },
    close(socket) {
      sockets.delete(socket);
    },
  },
});
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  for (const socket of sockets) socket.close();
  server.stop(true);
  document.destroy();
});
const reset = () => {
  for (const socket of sockets) socket.close();
  sockets.clear();
  document.destroy();
  document = createDraftDocument(base);
  durable = Y.encodeStateAsUpdate(document);
  generation = "1";
  revision = 1;
  seq = 1;
  saveFails = false;
  denied = false;
  lifecycle = "draft";
  frozen = null;
  requests.length = 0;
  recoveries.length = 0;
};
const open = async (width = 1440) => {
  reset();
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url.href);
  await page.waitForFunction(() => window.mailSharedFixture?.state()?.ready);
  await settled(page);
  return { page, context, errors };
};
const waitStored = async (page: Page, target: number) => {
  await page.waitForFunction(
    (expected) =>
      new Promise<boolean>((resolve, reject) => {
        const request = indexedDB.open("cloud-shared-text-offline");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction("drafts", "readonly"),
            count = tx.objectStore("drafts").count();
          count.onsuccess = () => resolve(count.result === expected);
          tx.oncomplete = () => db.close();
        };
      }),
    target,
  );
};
// Real Yjs, real provider, real WebSocket and IndexedDB, real Mail session and shared editor.
// The fixture replaces authorization/domain persistence; it does not claim server admission coverage.
for (const width of [1440, 390])
  test(`remote body/header merge and durable save, width=${width}`, async () => {
    const { page, context, errors } = await open(width);
    try {
      if (width === 390) await page.evaluate(() => (globalThis.document.documentElement.className = "dark"));
      const editor = page.locator(".cm-content").first();
      await editor.click();
      await page.keyboard.press("Control+Home");
      await page.keyboard.type("Local ");
      await page.waitForFunction(() => !window.mailSharedFixture.unsent());
      await waitStored(page, 1); // Echo has arrived, but SQL durability has not.
      const vector = Y.encodeStateVector(document);
      const before = readDraftDocument(document);
      writeLocalDraftHeaders(document, before, { ...before, subject: "Peer subject", bcc: [{ name: null, address: "peer@example.test" }] });
      document.getText(DRAFT_BODY).insert(document.getText(DRAFT_BODY).length, "\nPeer footer");
      publish(Y.encodeStateAsUpdate(document, vector));
      await page.waitForFunction(() => window.mailSharedFixture.content().subject === "Peer subject");
      expect(await page.evaluate(() => window.mailSharedFixture.content().body)).toContain("Local Hello");
      expect(await page.evaluate(() => window.mailSharedFixture.content().body)).toContain("Peer footer");
      expect(await page.evaluate(() => window.mailSharedFixture.state()?.recipientsChanged)).toBe(true);
      const peer = new Awareness(document);
      peer.setLocalState({
        cursor: {
          anchor: Y.createRelativePositionFromTypeIndex(
            document.getText(DRAFT_BODY),
            document.getText(DRAFT_BODY).toString().indexOf("Pen"),
          ),
          head: Y.createRelativePositionFromTypeIndex(document.getText(DRAFT_BODY), document.getText(DRAFT_BODY).toString().indexOf("Pen")),
        },
      });
      const trusted = createTrustedTextAwareness({
        clientId: 2 ** 32 + 10,
        textName: DRAFT_BODY,
        user: { userId: "Usr002", name: "Grace", color: "#c2410c" },
      });
      const presence = trusted.publish(encodeAwarenessUpdate(peer, [document.clientID]));
      peer.destroy();
      for (const socket of sockets)
        packet(socket, "awarenessPush", {
          docId: "Draft1",
          generation: "1",
          updates: [{ generation: "1", payload: encoding.toBase64(presence), originPeerId: "peer" }],
        });
      await page.locator('.k2b-ste-cell[data-mail-peer="Grace"]').waitFor();
      await editor.click();
      await page.keyboard.press("Control+z");
      await page.waitForFunction(() => !window.mailSharedFixture.content().body.includes("Local "));
      expect(await page.evaluate(() => window.mailSharedFixture.content().body)).toContain("Peer footer");
      await page.keyboard.press("Control+Shift+z");
      await page.waitForFunction(() => window.mailSharedFixture.content().body.includes("Local Hello"));
      expect(requests.filter((value) => value.includes("/lease"))).toEqual([]);
      saveFails = true;
      await page.getByRole("button", { name: "Speichern", exact: true }).click();
      await page.locator("[data-save-error]").filter({ hasText: "fehlgeschlagen" }).waitFor();
      await waitStored(page, 1);
      saveFails = false;
      await page.getByRole("button", { name: "Speichern", exact: true }).click();
      await page.waitForFunction(() => window.mailSharedFixture.savedRevision() === 2);
      await waitStored(page, 0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 30_000);

test("offline input survives cleanup/reload, then closes as one stable Rest request", async () => {
  const { page, context, errors } = await open();
  try {
    await context.setOffline(true);
    for (const socket of sockets) socket.close(1012, "offline");
    await page.waitForFunction(() => !window.mailSharedFixture.state()?.connected);
    const editor = page.locator(".cm-content").first();
    await editor.click();
    await page.keyboard.press("Control+Home");
    await page.keyboard.type("Offline ");
    await page.waitForFunction(() => window.mailSharedFixture.state()?.locallySaved);
    await waitStored(page, 1);
    expect(await page.locator(".k2b-ste-status").innerText()).toContain("Offline");
    // The sent boundary excludes the disconnected edit. Re-authorize on reload before reading device bytes.
    frozen = Y.encodeStateAsUpdate(document);
    durable = frozen;
    generation = "2";
    lifecycle = "draft";
    await context.setOffline(false);
    await page.reload();
    await page.waitForFunction(() => window.mailSharedFixture?.state()?.recoveryDraft?.id === "Rest01");
    expect(await page.evaluate(() => window.mailSharedFixture.content().body)).toContain("Offline Hello");
    await page.evaluate(() => window.mailSharedFixture.recover());
    expect(recoveries.length).toBeGreaterThanOrEqual(2);
    expect(new Set(recoveries.map((entry) => entry.clientId)).size).toBe(1);
    expect(recoveries.every((entry) => entry.generation === "1")).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 30_000);

test("permission loss preserves readable input; device opt-out prevents local persistence", async () => {
  const { page, context, errors } = await open();
  try {
    await page.evaluate(() => window.mailSharedFixture.remember(false));
    const editor = page.locator(".cm-content").first();
    await editor.click();
    await page.keyboard.press("Control+Home");
    await page.keyboard.type("Keep ");
    await page.waitForFunction(() => !window.mailSharedFixture.unsent());
    await waitStored(page, 0);
    denied = true;
    for (const socket of sockets) packet(socket, "error", { docId: "Draft1", code: "ACCESS_DENIED", message: "Zugriff entzogen" });
    await page.waitForFunction(() => window.mailSharedFixture.state()?.terminal);
    expect(await page.evaluate(() => window.mailSharedFixture.content().body)).toContain("Keep Hello");
    expect(await editor.getAttribute("contenteditable")).toBe("false");
    expect(await page.locator(".k2b-ste-status").innerText()).toContain("Zugriff entzogen");
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 30_000);
