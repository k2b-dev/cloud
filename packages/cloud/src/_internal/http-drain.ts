import type { Server } from "bun";

/** Matches the existing runtime worker drain deadline. */
export const HTTP_DRAIN_TIMEOUT_MS = 30_000;

/** Bun supplies the listening server to fetch, including for default-export entrypoints. */
export const createHttpDrain = (options: { timeoutMs?: number } = {}) => {
  type HttpServer = Pick<Server<unknown>, "stop">;
  const isHttpServer = (value: unknown): value is HttpServer =>
    typeof value === "object" && value !== null && "stop" in value && typeof value.stop === "function";
  const servers = new Set<HttpServer>();
  let stopping = false;
  let draining: Promise<void> | undefined;
  return {
    get stopping() {
      return stopping;
    },
    fetch: async (request: Request, transport: unknown, handle: (request: Request) => Response | Promise<Response>): Promise<Response> => {
      const server = isHttpServer(transport) ? transport : undefined;
      if (server) servers.add(server);
      if (stopping) {
        // A listener that had not served a request before the signal was not
        // captured yet. Reject that first request and close it as well.
        void server?.stop(false);
        return Response.json({ status: "stopping" }, { status: 503, headers: { "Retry-After": "3", Connection: "close" } });
      }
      // Preserve Bun request identity for websocket upgrades, requestIP and
      // per-request timeouts. Forced stop aborts the native request signal.
      return handle(request);
    },
    stop: (): Promise<void> => {
      stopping = true;
      draining ??= (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        try {
          await Promise.race([
            Promise.all([...servers].map((server) => server.stop(false))),
            new Promise<void>((resolve) => {
              timer = setTimeout(() => {
                // Cancel application work as well as the transport, before
                // lifecycle hooks can tear down NATS or other dependencies.
                timedOut = true;
                resolve();
              }, options.timeoutMs ?? HTTP_DRAIN_TIMEOUT_MS);
            }),
          ]);
          if (timedOut) await Promise.all([...servers].map((server) => server.stop(true)));
        } finally {
          clearTimeout(timer);
        }
      })();
      return draining;
    },
  };
};
