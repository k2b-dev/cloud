#!/usr/bin/env bun
import { parseArgs } from "node:util";

export const help = `Usage: bun --smol --no-env-file packages/mail/scripts/draft-document-load.ts [options]

Runs real Mail Yjs WebSockets, SQL and JetStream in one process, with simulated
browser identity only. Uses CLOUD_TEST_DATABASE_URL (ending _test),
CLOUD_TEST_NATS_SERVERS and CLOUD_TEST_VALKEY_URL; creates/drops a private DB
and Sync namespace. Never starts containers or enables shared mailbox editing.

  --drafts N       Concurrent drafts (default 10)
  --clients N      Editors per draft (default 3, at least 2)
  --seconds N      Measured duration (default 60, maximum 600)
  --interval-ms N  Typing burst interval per editor (default 2000)
  --body-bytes N   Initial ASCII body size (default 4096)
  --burst-bytes N  First editor's paste/delete burst (default 0, up to 256 KiB;
                   requires body-bytes >= burst-bytes)
  --rss-mib N      Abort RSS budget, including clients (default 1024)
  --out PATH      New result directory (default .local/mail-draft-load/<timestamp>)
  --help          Show this help

Includes awareness, reconnect, abrupt transport termination, request abort and
one TCP consumer that stops reading. Samples every second, records latency in
fixed 10 ms histogram buckets, checks final convergence and drains all sockets.
Aborts when the one-minute host load exceeds 40. Run with nice -n 19 and an
external memory/CPU cgroup for a hard process budget; --smol is a GC hint, not a
heap cap. RSS includes the load-generator clients. No production throughput claim.
`;

export function options(args: string[]) {
  const { values } = parseArgs({
    args,
    options: Object.fromEntries(
      ["drafts", "clients", "seconds", "interval-ms", "body-bytes", "burst-bytes", "rss-mib", "out"].map((key) => [
        key,
        { type: "string" as const },
      ]),
    ),
  });
  const number = (key: string, fallback: number, min: number, max: number) => {
    const value = values[key] === undefined ? fallback : Number(values[key]);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`--${key} must be ${min}..${max}`);
    return value;
  };
  const bodyBytes = number("body-bytes", 4096, 0, 2 * 1024 * 1024);
  // One eighth of the 2 Mi character document contract leaves room for all eight peers.
  const burstBytes = number("burst-bytes", 0, 0, 256 * 1024);
  if (burstBytes > bodyBytes) throw new Error("--body-bytes must cover --burst-bytes");
  return {
    drafts: number("drafts", 10, 1, 500),
    clients: number("clients", 3, 2, 8),
    seconds: number("seconds", 60, 1, 600),
    intervalMs: number("interval-ms", 2000, 100, 60_000),
    bodyBytes,
    burstBytes,
    rssMib: number("rss-mib", 1024, 128, 8192),
    out: values.out,
  };
}
export type Options = ReturnType<typeof options>;

if (import.meta.main) {
  try {
    if (Bun.argv.includes("--help")) console.log(help);
    else {
      const selected = options(Bun.argv.slice(2));
      const { run } = await import("./draft-document-load/runner");
      await run(selected);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
