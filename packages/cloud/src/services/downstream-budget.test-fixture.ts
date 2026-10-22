import { createInterface } from "node:readline";
import { downstreamBudget } from "./downstream-budget";

const downstream = process.argv[2];
if (downstream !== "gotenberg" && downstream !== "smtp") throw new Error("Unknown downstream");
const timeoutMs = Number(process.argv[3] ?? 60_000);
const command = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
try {
  const release = await downstreamBudget.acquire({ downstream, timeoutMs, signal: AbortSignal.timeout(timeoutMs) });
  console.log("admitted");
  await command.next();
  release();
  // Order a subsequent command on the same connection before exiting, so the
  // parent can observe a deliberate release without a timer race.
  const { requestCacheRedis } = await import("./request-cache-redis");
  await (await requestCacheRedis()).send("PING", []);
  console.log("released");
  process.exit(0);
} catch (error) {
  console.log(error instanceof Error ? error.name : "failed");
  process.exit(1);
}
