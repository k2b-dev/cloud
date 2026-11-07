import { dirname } from "node:path";
import { routes } from "@k2b/ssr/bun";
import { readServerEnv } from "./env";
import { createSpeedtestHandler } from "./server";
import { config } from "./site/config";
import { renderPublicPage } from "./site/page";
import { createUdpHandler } from "./udp";

if (Bun.argv.includes("--help")) {
  console.log(
    "Standalone speedtest server\nEnvironment: SPEEDTEST_HOST, SPEEDTEST_PORT (8080), SPEEDTEST_PUBLIC_URL (required), SPEEDTEST_UDP_PORT (disabled), SPEEDTEST_CAPACITY_MBPS (1000), SPEEDTEST_TEST_MBPS (1000), SPEEDTEST_MAX_ACTIVE (128), SPEEDTEST_MAX_PEERS (4096), SPEEDTEST_UDP_PACKETS_PER_SECOND (4096), SPEEDTEST_TRUSTED_PROXIES (exact IP list).\nGET /de, GET /en, POST /session, GET /session, POST /session/end, GET /ping, GET /download, POST /upload, GET /cli, GET /health. No Cloud dependency.",
  );
} else {
  const options = readServerEnv();
  const assets: unknown = await Bun.file(new URL("./assets.json", import.meta.url)).json();
  if (
    !assets ||
    typeof assets !== "object" ||
    !("stylesheet" in assets) ||
    typeof assets.stylesheet !== "string" ||
    !/^site-[a-z0-9]+\.css$/.test(assets.stylesheet)
  )
    throw new Error("Missing speedtest asset manifest");
  const stylesheet = assets.stylesheet;
  const script = await Bun.file(new URL("./cli.js", import.meta.url)).text();
  const handler = createSpeedtestHandler({ ...options, script });
  const server = Bun.serve({
    hostname: options.hostname,
    port: options.port,
    routes: {
      ...routes(config),
      "/": { GET: () => renderPublicPage("de", options.publicUrl, stylesheet) },
      "/de": { GET: () => renderPublicPage("de", options.publicUrl, stylesheet) },
      "/en": { GET: () => renderPublicPage("en", options.publicUrl, stylesheet) },
      "/assets/:filename": {
        GET: async (request) => {
          const filename = request.params.filename;
          if (!/^[a-zA-Z0-9._-]+$/.test(filename)) return new Response("Not found", { status: 404 });
          const file = Bun.file(`${dirname(Bun.main)}/assets/${filename}`);
          if (!(await file.exists())) return new Response("Not found", { status: 404 });
          return new Response(file, {
            headers: {
              "Cache-Control": filename === stylesheet ? "public, max-age=31536000, immutable" : "public, max-age=3600",
              "X-Content-Type-Options": "nosniff",
            },
          });
        },
      },
    },
    maxRequestBodySize: 16 * 1024 * 1024,
    idleTimeout: 15,
    fetch: (request, current) => handler(request, current.requestIP(request)?.address ?? ""),
  });
  const handleUdp = createUdpHandler(options);
  const udp = options.udpPort
    ? await Bun.udpSocket({
        hostname: options.hostname,
        port: options.udpPort,
        socket: {
          data(socket, packet, port, address) {
            const reply = handleUdp(packet, address, port);
            if (reply) socket.send(reply, port, address);
          },
        },
      })
    : undefined;
  console.log(`Speedtest HTTP listening on ${server.hostname}:${server.port}; UDP ${udp ? options.udpPort : "disabled"}`);
  const stop = () => {
    udp?.close();
    void server.stop(true);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
