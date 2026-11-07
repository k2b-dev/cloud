import { type CloudCliContext, printStructured } from "@k2b/cloud/cli";
import { DEFAULT_SERVER, normalizeServer, PLANS, type Progress, runSpeedtest, SpeedtestError } from "@k2b/speedtest";
import { createNodeTransport } from "@k2b/speedtest/node";
import { runUdpTest } from "@k2b/speedtest/udp-client";
import { speedTestMessages } from "./frontend/tools/speedtest-messages";

export async function runCloudSpeedtest(ctx: CloudCliContext) {
  const { t, locale } = speedTestMessages.resolve(ctx.options.locale ? [ctx.options.locale] : []);
  const explicit = ctx.flags.server;
  if (explicit !== undefined && typeof explicit !== "string") throw new Error("--server requires a URL");
  const mode = ctx.flags.mode ?? "quick";
  if (mode !== "quick" && mode !== "accurate") throw new Error("--mode must be quick or accurate");
  let server = explicit ?? DEFAULT_SERVER;
  // Only this request uses the Cloud context. Measurement transports never see its credentials.
  if (!explicit && ctx.options.server) {
    const response = await ctx.fetch("/tools/api/speedtest/config", { signal: AbortSignal.timeout(PLANS.quick.ping) });
    const config: unknown = await ctx.readJson(response);
    if (
      !config ||
      typeof config !== "object" ||
      !("server" in config) ||
      typeof config.server !== "string" ||
      !("enabled" in config) ||
      typeof config.enabled !== "boolean"
    )
      throw new Error("Invalid Cloud speedtest settings response");
    if (!config.enabled) throw new Error(t.disabled);
    server = config.server;
  }
  try {
    server = normalizeServer(server);
  } catch {
    throw new Error(t.invalid);
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const tty = !!process.stderr.isTTY;
  let lineOpen = false;
  let lastUpdate = -Infinity;
  const onProgress = (event: Progress) => {
    if (!event.phase_complete && performance.now() - lastUpdate < 125) return;
    lastUpdate = performance.now();
    const phase = { ping: t.phasePing, download: t.phaseDownload, upload: t.phaseUpload }[event.phase];
    const reading = event.phase === "ping" ? `${event.ping_ms ?? "—"} ms` : `${event.mbps.toPrecision(3)} Mbit/s`;
    const line = `${phase}: ${reading} · ${t.remaining({ seconds: Math.ceil(event.remaining_ms / 1_000) })}`;
    if (tty) {
      process.stderr.write(`\r\x1b[2K${line}`);
      lineOpen = true;
    } else if (event.phase_complete) ctx.error(line);
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    ctx.error(`${t.server}: ${server}`);
    const udpPort = ctx.flags["udp-port"];
    const result =
      ctx.flags.udp === true
        ? await runUdpTest(server, { port: typeof udpPort === "string" ? Number(udpPort) : undefined, signal: controller.signal })
        : await runSpeedtest({ server, mode, transport: createNodeTransport(server), signal: controller.signal, onProgress });
    if (lineOpen) {
      process.stderr.write("\r\x1b[2K");
      lineOpen = false;
    }
    if (!printStructured(ctx, result)) {
      const format = (value: number | null) =>
        value === null ? "—" : new Intl.NumberFormat(locale, { maximumSignificantDigits: 3 }).format(value);
      ctx.print(
        "download_mbps" in result
          ? `${t.phaseDone}\n${t.ping}: ${format(result.ping_ms)} ms\n${t.jitter}: ${format(result.jitter_ms)} ms\nDownload: ${format(result.download_mbps)} Mbit/s\nUpload: ${format(result.upload_mbps)} Mbit/s\n${t.loaded}: ${format(result.loaded_latency_ms)} ms`
          : JSON.stringify(result, null, 2),
      );
    }
  } catch (error) {
    if (error instanceof SpeedtestError) {
      if (error.code === "cancelled") throw new Error(t.cancelled);
      if (error.status === 429) throw new Error(error.retryAfter ? t.rateLimited({ seconds: error.retryAfter }) : t.rateLimitedUnknown);
      if (error.code === "capacity") throw new Error(t.capacity);
      if (error.status === 503 && error.retryAfter) throw new Error(t.busy({ seconds: error.retryAfter }));
      if (error.code === "slow_server") throw new Error(t.slow);
      if (error.status) throw new Error(t.http({ status: error.status }));
      if (error.code === "network") throw new Error(t.network);
    }
    throw error;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    if (lineOpen) process.stderr.write("\n");
  }
}
