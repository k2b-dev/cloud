import { DEFAULT_SERVER, type Progress, runSpeedtest, SpeedtestError } from "./engine";
import { createNodeTransport } from "./node";
import { runUdpTest } from "./udp-client";

export async function main(args: string[]) {
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    if (index < 0) return undefined;
    const next = args[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`${flag} requires a value`);
    return next;
  };
  if (args.includes("--help")) {
    console.log(
      "speedtest [--server https://speedtest.k2b.dev] [--mode quick|accurate] [--json] [--locale de|en] [--udp] [--udp-port 8080]\nHTTP: up to 14 s / 29 s. --udp measures latency, jitter and packet loss only (up to 2 s); no throughput test. Ctrl+C cancels.",
    );
    return;
  }
  const mode = value("--mode") ?? "quick";
  if (mode !== "quick" && mode !== "accurate") throw new Error("--mode must be quick or accurate");
  const server = value("--server") ?? DEFAULT_SERVER;
  const german = value("--locale") === "de";
  const tty = process.stderr.isTTY;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  let lineOpen = false;
  const progress = (event: Progress) => {
    const phase = german ? { ping: "Ping", download: "Download", upload: "Upload", verify: "Prüfung" }[event.phase] : event.phase;
    const seconds = Math.ceil(event.remaining_ms / 1_000);
    const text = `${phase}: ${event.mbps.toPrecision(3)} Mbit/s · ${german ? `noch ${seconds} s` : `${seconds} s left`}`;
    if (tty) {
      process.stderr.write(`\r\x1b[2K${text}`);
      lineOpen = true;
    } else if (event.phase_complete) {
      const reading = event.phase === "ping" ? `${event.ping_ms} ms · Jitter ${event.jitter_ms} ms` : `${event.mbps.toPrecision(3)} Mbit/s`;
      process.stderr.write(`${phase}: ${reading} · ${german ? `noch ${seconds} s` : `${seconds} s left`}\n`);
    }
  };
  try {
    const result = args.includes("--udp")
      ? await runUdpTest(server, { port: value("--udp-port") ? Number(value("--udp-port")) : undefined, signal: controller.signal })
      : await runSpeedtest({ server, mode, transport: createNodeTransport(server), signal: controller.signal, onProgress: progress });
    if (lineOpen) {
      process.stderr.write("\r\x1b[2K");
      lineOpen = false;
    }
    console.log(JSON.stringify(result, null, args.includes("--json") ? undefined : 2));
  } catch (error) {
    if (error instanceof SpeedtestError && error.retryAfter) {
      throw new Error(
        german
          ? `Test derzeit nicht möglich · noch ${error.retryAfter} s bis zum nächsten Versuch`
          : `Test unavailable · ${error.retryAfter} s until the next attempt`,
      );
    }
    throw error;
  } finally {
    process.removeListener("SIGINT", cancel);
    if (lineOpen) process.stderr.write("\n");
  }
}
if (import.meta.main)
  await main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Speedtest failed");
    process.exitCode = 1;
  });
