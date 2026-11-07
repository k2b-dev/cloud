import { readServerEnv } from "./env";
import { createSpeedtestHandler } from "./server";
import { createUdpHandler } from "./udp";

if (Bun.argv.includes("--help")) {
  console.log(
    "Standalone speedtest server\nEnvironment: SPEEDTEST_HOST, SPEEDTEST_PORT (8080), SPEEDTEST_UDP_PORT (disabled), SPEEDTEST_MAX_ACTIVE (128), SPEEDTEST_MAX_PEERS (4096), SPEEDTEST_UDP_PACKETS_PER_SECOND (4096), SPEEDTEST_TRUSTED_PROXIES (exact IP list).\nGET /ping, GET /download, POST /upload, GET /cli, GET /health. No Cloud dependency.",
  );
} else {
  const options = readServerEnv();
  const script = await Bun.file(new URL("./cli.js", import.meta.url)).text();
  const handler = createSpeedtestHandler({ ...options, script });
  const server = Bun.serve({
    hostname: options.hostname,
    port: options.port,
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
