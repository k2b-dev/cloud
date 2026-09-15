/** Real-time shared-runtime acceptance on disposable NATS and Bun containers. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_REGISTRY_TTL_MS } from "../src/_internal/registry";

const name = `cloud-runtime-acceptance-${crypto.randomUUID().slice(0, 8)}`;
const directory = await mkdtemp(join(tmpdir(), `${name}-`));
const broker = `${name}-broker`;
const worker = `${name}-worker`;
const report = { name, ttlMs: APP_REGISTRY_TTL_MS, observationMs: 0, probes: 0, beforeWedge: {}, restartCount: 0, cleanExit: -1 };
const docker = async (...args: string[]): Promise<string> => {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 60000);
  try {
    const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`docker ${args[0]} failed: ${error}`);
    return (args[0] === "logs" ? out + error : out).trim();
  } finally {
    clearTimeout(timer);
  }
};
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
type State = { boot: string; registered: boolean; ttlMs: number; counts: Record<string, number> };
let url = "";
const state = async (): Promise<State> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  check(response.ok, `HTTP probe failed: ${response.status}`);
  return (await response.json()) as State;
};
const waitForState = async (predicate: (value: State) => boolean, timeoutMs: number, refreshPort = false): Promise<State> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (refreshPort) url = `http://${await docker("port", worker, "3000/tcp")}`;
      const current = await state();
      if (predicate(current)) return current;
    } catch {
      /* Container startup/restart is expected here. */
    }
    await Bun.sleep(1000);
  }
  throw new Error("Timed out waiting for the isolated worker");
};
try {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "runtime-recovery-worker.ts")],
    outdir: directory,
    naming: "worker.js",
    target: "bun",
  });
  check(built.success, `Fixture build failed: ${built.logs.join("\n")}`);
  await docker("network", "create", name);
  await docker(
    "run",
    "-d",
    "--name",
    broker,
    "--network",
    name,
    "--network-alias",
    "broker",
    "nats:2.14.3-alpine",
    "-js",
    "-sd",
    "/tmp/recovery-js",
  );
  await docker(
    "run",
    "-d",
    "--name",
    worker,
    "--restart",
    "on-failure:3",
    "--network",
    name,
    "--network-alias",
    "worker",
    "-p",
    "127.0.0.1::3000",
    "-e",
    `RECOVERY_NAMESPACE=${name}`,
    "-v",
    `${directory}:/fixture:ro`,
    "oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895",
    "bun",
    "/fixture/worker.js",
  );
  const port = await docker("port", worker, "3000/tcp");
  url = `http://${port}`;
  const initial = await waitForState((value) => value.registered, 60000);
  check(initial.ttlMs === APP_REGISTRY_TTL_MS, "Fixture changed the production registry TTL");
  const startedAt = Date.now();
  let current = initial;
  console.log(JSON.stringify({ phase: "observing", name, ttlMs: APP_REGISTRY_TTL_MS, requiredMs: APP_REGISTRY_TTL_MS * 3 + 5000 }));
  while (Date.now() - startedAt <= APP_REGISTRY_TTL_MS * 3 + 5000) {
    await Bun.sleep(5000);
    current = await state();
    check(current.boot === initial.boot, "Ordinary failures restarted the worker");
    check(current.registered, "Registry entry vanished during ordinary worker failure");
    check(current.counts.unexpectedFailures === 0, "Unexpected publisher or FreeIPA failure");
    report.probes++;
    if (report.probes % 12 === 0)
      console.log(JSON.stringify({ phase: "observing", elapsedMs: Date.now() - startedAt, counts: current.counts }));
  }
  report.observationMs = Date.now() - startedAt;
  report.beforeWedge = current.counts;
  for (const key of [
    "queueErrors",
    "topicErrors",
    "watcherErrors",
    "timerErrors",
    "ipaInvalid",
    "ipaTimeout",
    "heartbeatErrors",
    "failedSlots",
  ]) {
    check((current.counts[key] ?? 0) >= 1, `Fault was not observed: ${key}`);
  }
  for (const key of ["queue", "topic", "watcher", "timer", "slots"])
    check((current.counts[key] ?? 0) > 2, `Later work did not recover: ${key}`);
  console.log(JSON.stringify({ phase: "wedging-heartbeat", observationMs: report.observationMs, counts: current.counts }));
  const response = await fetch(`${url}/wedge`, { method: "POST", signal: AbortSignal.timeout(5000) });
  check(response.ok, "Could not inject heartbeat hang");
  const recovered = await waitForState((value) => value.boot !== initial.boot && value.registered, APP_REGISTRY_TTL_MS + 90000, true);
  report.restartCount = Number(await docker("inspect", "--format", "{{.RestartCount}}", worker));
  check(report.restartCount === 1, `Unexpected restart count ${report.restartCount}`);
  const logs = await docker("logs", worker);
  check(logs.includes('"event":"stale-exit"'), "No controlled nonzero lease expiry exit observed");
  check(logs.includes(recovered.boot), "Restart did not register the new process");
  await docker("stop", "--time", "20", worker);
  report.cleanExit = Number(await docker("inspect", "--format", "{{.State.ExitCode}}", worker));
  check(report.cleanExit === 0, `Shutdown failed with exit ${report.cleanExit}`);
  check((await docker("logs", worker)).includes('"event":"clean-shutdown"'), "No completed shutdown marker");
  console.log(
    JSON.stringify({
      phase: "passed",
      ...report,
      scope: "Cloud shared runtime seams with real NATS and HTTP; no full Core/domain startup or fleet rollout",
    }),
  );
} catch (error) {
  console.error(await docker("logs", worker).catch(() => "Worker container not created"));
  throw error;
} finally {
  await docker("rm", "-f", worker).catch(() => undefined);
  await docker("rm", "-f", broker).catch(() => undefined);
  await docker("network", "rm", name).catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
