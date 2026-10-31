import { resolve } from "node:path";
import { encoding } from "@k2b/stdlib";
import type { ServerWebSocket } from "bun";
import * as Y from "yjs";
import { notebooksYjs } from "../../../lib/yjs";

export async function startOfflineNotebookFixture() {
  const ui = resolve(import.meta.dir, "../../../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", `${ui}/`));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", `${ui}/`))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", `${ui}/`))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "offline.browser-harness.tsx")],
    target: "browser",
    format: "esm",
    splitting: true,
    naming: { entry: "harness.[ext]", chunk: "chunk-[hash].[ext]", asset: "asset-[hash].[ext]" },
    treeShaking: false,
    conditions: ["browser", "production"],
    minify: false,
    plugins: [
      {
        name: "solid-offline-notebook",
        setup(builder) {
          builder.onResolve({ filter: /\/offline$/ }, ({ importer }) =>
            importer.endsWith("NoteEditor.client.tsx") ? { path: resolve(import.meta.dir, "offline.browser-controller.ts") } : undefined,
          );
          builder.onResolve({ filter: /^@k2b\/ui$/ }, () => ({ path: resolve(ui, "src/index.ts") }));
          builder.onResolve({ filter: /^@k2b\/ui\/text-editor$/ }, () => ({ path: resolve(ui, "src/text-editor.ts") }));
          builder.onResolve({ filter: /^@k2b\/ui\/text-editor\/model$/ }, () => ({
            path: resolve(ui, "src/text-editor/markdown-table.ts"),
          }));
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
  if (!build.success) throw new AggregateError(build.logs, "Offline notebook harness build failed");
  let doc = new Y.Doc();
  doc.getText("codemirror").insert(0, "Saved\n");
  let initialState = encoding.toBase64(Y.encodeStateAsUpdate(doc));
  let accepts = false;
  let terminal = false;
  let sessionExpired = false;
  let conflict = false;
  let receipts = false;
  let generation = "0";
  let historyIncomplete = false;
  let authorizationStatus = 200;
  let locked = false;
  const sockets = new Set<ServerWebSocket<{ noteId: string }>>();
  const cursor = "s6t.bm90ZWJvb2tz.1";
  const server = Bun.serve<{ noteId: string }>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      const asset = build.outputs.find((output) => url.pathname === `/${output.path.split("/").at(-1)}`);
      if (asset) return new Response(asset);
      if (url.pathname.startsWith("/api/") && !url.pathname.endsWith("/document") && url.pathname !== "/api/notebooks/ws")
        return Response.json({ text: "Saved\n", items: [], nextCursor: null, cursor: null });
      if (url.pathname === "/conflict") {
        terminal = true;
        conflict = true;
        receipts = true;
        doc.transact(() => {
          const text = doc.getText("codemirror");
          text.delete(0, text.length);
          text.insert(0, "Server replacement\n");
        });
        initialState = encoding.toBase64(Y.encodeStateAsUpdate(doc));
        return Response.json({ ok: true });
      }
      if (url.pathname === "/session-expired") {
        sessionExpired = true;
        return Response.json({ ok: true });
      }
      if (url.pathname === "/lock") {
        locked = true;
        for (const socket of sockets)
          socket.send(
            JSON.stringify({ type: notebooksYjs.wsType.error, payload: { noteId: "Note01", code: "NOTE_LOCKED", message: "Note locked" } }),
          );
        return Response.json({ ok: true });
      }
      if (url.pathname === "/history-incomplete") {
        historyIncomplete = true;
        return Response.json({ ok: true });
      }
      if (url.pathname === "/deny") {
        authorizationStatus = 403;
        return Response.json({ ok: true });
      }
      if (url.pathname === "/authorize") {
        authorizationStatus = 200;
        return Response.json({ ok: true });
      }
      if (url.pathname === "/restore") {
        generation = "1";
        doc.destroy();
        doc = new Y.Doc();
        doc.getText("codemirror").insert(0, "Restored note\n");
        initialState = encoding.toBase64(Y.encodeStateAsUpdate(doc));
        return Response.json({ ok: true });
      }
      if (url.pathname === "/accept") {
        accepts = true;
        terminal = false;
        sessionExpired = false;
        return Response.json({ ok: true });
      }
      if (url.pathname === "/receipts") {
        receipts = true;
        return Response.json({ ok: true });
      }
      if (url.pathname === "/drop") {
        for (const socket of sockets) socket.close(1012);
        return Response.json({ ok: true });
      }
      if (url.pathname === "/terminal") {
        terminal = true;
        return Response.json({ ok: true });
      }
      if (url.pathname.endsWith("/document")) {
        if (authorizationStatus !== 200 || url.searchParams.get("expectedUserId") !== "user-1") return new Response(null, { status: 403 });
        return Response.json({
          generation,
          mode: url.searchParams.has("generation") && url.searchParams.get("generation") !== generation ? "recovery" : "current",
          historyIncomplete,
          locked,
          durable: { state: receipts ? encoding.toBase64(Y.encodeStateAsUpdate(doc)) : initialState, cursor },
        });
      }
      if (url.pathname === "/api/notebooks/ws") {
        if (server.upgrade(request, { data: { noteId: "Note01" } })) return;
        return new Response("Upgrade failed", { status: 400 });
      }
      return new Response(
        '<!doctype html><html><head><style>body{margin:0}#root{height:100vh;display:flex}.cm-editor{min-height:200px}.overflow-hidden{overflow:hidden}.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1}.k2b-scroll-area{overflow:auto}</style></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>',
        {
          headers: { "content-type": "text/html" },
        },
      );
    },
    websocket: {
      open(socket) {
        sockets.add(socket);
      },
      close(socket) {
        sockets.delete(socket);
      },
      message(socket, raw) {
        const msg = JSON.parse(String(raw));
        const send = (type: string, payload: unknown) => socket.send(JSON.stringify({ type, payload }));
        if (msg.type === notebooksYjs.wsType.replayRequest) {
          send(notebooksYjs.wsType.syncPush, {
            noteId: "Note01",
            snapshot: true,
            restoreRevision: generation,
            updates: [{ payload: receipts ? encoding.toBase64(Y.encodeStateAsUpdate(doc)) : initialState, cursor }],
          });
          send(notebooksYjs.wsType.replayReady, { noteId: "Note01", restoreRevision: generation, cursor });
        }
        if (msg.type === notebooksYjs.wsType.syncPublish) {
          if (sessionExpired) {
            send(notebooksYjs.wsType.error, { noteId: "Note01", code: "SESSION_EXPIRED", message: "Sign in again" });
          } else if (terminal) {
            if (conflict)
              send(notebooksYjs.wsType.syncPush, {
                noteId: "Note01",
                restoreRevision: generation,
                updates: [{ payload: encoding.toBase64(Y.encodeStateAsUpdate(doc)), cursor, restoreRevision: generation }],
              });
            send(notebooksYjs.wsType.error, { noteId: "Note01", code: "RESYNC_REQUIRED", reopen: true, message: "Recovery required" });
          } else if (accepts) {
            Y.applyUpdate(doc, encoding.fromBase64(msg.payload.payload));
            send(notebooksYjs.wsType.syncPush, {
              noteId: "Note01",
              restoreRevision: generation,
              updates: [{ payload: msg.payload.payload, cursor, restoreRevision: generation }],
            });
          }
        }
      },
    },
  });
  return {
    reset() {
      for (const socket of sockets) socket.close(1012);
      doc.destroy();
      doc = new Y.Doc();
      doc.getText("codemirror").insert(0, "Saved\n");
      initialState = encoding.toBase64(Y.encodeStateAsUpdate(doc));
      accepts = false;
      terminal = false;
      conflict = false;
      receipts = false;
      generation = "0";
      historyIncomplete = false;
      authorizationStatus = 200;
      sessionExpired = false;
      locked = false;
    },
    url: new URL("/app/notebooks/Book01/notes/Note01?mode=write", server.url),
    text: () => doc.getText("codemirror").toString(),
    stop() {
      server.stop(true);
      doc.destroy();
    },
  };
}
