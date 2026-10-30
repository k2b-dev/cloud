import type { SQL } from "bun";
import { createNotesApp, type HttpOptions } from "./app";
import { databaseReady } from "./database";
import { NotesError } from "./errors";
import { requireOrigin } from "./http";
import { limits, requestIp } from "./limits";
import { type Connection, type NotesOptions, NotesService } from "./service";
import { NotesStore } from "./store";

type SocketData = { connection: Connection };
export const serveNotes = async (db: SQL, options: NotesOptions & HttpOptions & { port?: number; hostname?: string }) => {
  const service = new NotesService(new NotesStore(db, options.storageBytes), options);
  await service.start();
  let stopping = false;
  const app = createNotesApp(async () => !stopping && (await databaseReady(db)) && !(await service.store.status()).full, service, options);
  let server: ReturnType<typeof Bun.serve<SocketData>>;
  try {
    server = Bun.serve<SocketData>({
      hostname: options.hostname,
      port: options.port ?? 3000,
      maxRequestBodySize: Math.ceil(limits.stateBytes / 3) * 4 + 1024,
      async fetch(request, server) {
        const peerIp = server.requestIP(request)?.address;
        const match = /^\/api\/pads\/([0-9A-Za-z]{22})\/ws$/.exec(new URL(request.url).pathname);
        if (!match) return app.fetch(request, { peerIp });
        let connection: Connection | undefined;
        try {
          requireOrigin(request, options.origin);
          if (stopping) throw new NotesError("unavailable", 503);
          connection = await service.admit(match[1]!, requestIp(peerIp, request.headers.get("x-forwarded-for"), options.trustedProxy));
          if (
            server.upgrade(request, {
              data: { connection },
              headers: { "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex", "Cache-Control": "private, no-store" },
            })
          )
            return;
          service.disconnect(connection);
          return new Response(null, { status: 400 });
        } catch (error) {
          if (connection) service.disconnect(connection);
          const failure = error instanceof NotesError ? error : new NotesError("unavailable", 503);
          if (!(error instanceof NotesError)) console.error("[notes] websocket_failed");
          return Response.json(
            { code: failure.code },
            {
              status: failure.status,
              headers: { "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex", "Cache-Control": "private, no-store" },
            },
          );
        }
      },
      error() {
        console.error("[notes] transport_failed");
        return Response.json({ code: "internal_error" }, { status: 500 });
      },
      websocket: {
        maxPayloadLength: limits.stateBytes + 256,
        backpressureLimit: limits.bufferBytes,
        closeOnBackpressureLimit: true,
        open(socket) {
          service
            .attach(socket.data.connection, {
              send: (bytes) => {
                socket.sendBinary(bytes);
              },
              close: (code, reason) => socket.close(code, reason),
              bufferedAmount: () => socket.getBufferedAmount(),
              ping: () => {
                socket.ping();
              },
            })
            .catch(() => {
              console.error("[notes] websocket_attach_failed");
              socket.close(1013, "resync_required");
            });
        },
        message(socket, data) {
          if (typeof data === "string") {
            socket.close(1003, "binary_required");
            return;
          }
          // receive owns and reports every failure, including persistence errors.
          void service.receive(socket.data.connection, new Uint8Array(data));
        },
        close(socket) {
          service.disconnect(socket.data.connection);
        },
        pong(socket) {
          service.pong(socket.data.connection);
        },
      },
    });
  } catch (error) {
    await service.stop();
    throw error;
  }
  return {
    server,
    service,
    app,
    stop: async () => {
      if (stopping) return;
      stopping = true;
      // HTTP admission closes immediately; existing sockets drain through the service.
      const listener = server.stop(false);
      try {
        await service.stop();
        await listener;
      } finally {
        await db.close();
      }
    },
  };
};
