import { mkdir, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { dirname, resolve } from "node:path";
import type { Options } from "../draft-document-load";
import { checkHost, within, writeSample } from "./common";
import { report } from "./report";

/** Only supervises: the load generator never shares the server's CPU/memory scope. */
export async function run(options: Options) {
  checkHost();
  const out = resolve(options.out ?? `.local/mail-draft-load/${new Date().toISOString().replaceAll(":", "-")}`);
  await mkdir(dirname(out), { recursive: true });
  await mkdir(out, { recursive: false });
  const uptime = async (name: string) => {
    const command = Bun.spawn(["uptime"], { stdout: "pipe", stderr: "pipe" });
    await Bun.write(`${out}/host-${name}.txt`, await new Response(command.stdout).text());
    await command.exited;
  };
  await uptime("start");
  const config = `${out}/config.json`;
  await writeFile(config, JSON.stringify({ options, out }));
  const children: Array<{ name: string; child: ReturnType<typeof Bun.spawn>; pid?: number }> = [];
  let failure: string | undefined;
  let stopped = false;
  const interrupt = () => {
    stopped = true;
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const start = (name: "server" | "server-2" | "clients") => {
    const command = [
      "nice",
      "-n",
      "19",
      process.execPath,
      "--smol",
      "--no-env-file",
      `${import.meta.dir}/${name === "clients" ? "clients" : "server"}.ts`,
      name === "server-2" ? `${out}/node-2/config.json` : config,
    ];
    if (options.bounded)
      command.unshift(
        "systemd-run",
        "--user",
        "--scope",
        "--quiet",
        `--unit=mail-b3-${name}-${process.pid}`,
        "-p",
        `MemoryMax=${name !== "clients" ? 1536 : 512}M`,
        "-p",
        `CPUQuota=${name !== "clients" ? 200 : 100}%`,
      );
    const child = Bun.spawn(command, {
      env: process.env,
      stdout: Bun.file(`${out}/${name}.stdout`),
      stderr: Bun.file(`${out}/${name}.stderr`),
    });
    const owned = { name, child, pid: options.bounded ? undefined : child.pid };
    children.push(owned);
    return owned;
  };
  const guard = () => {
    checkHost();
    if (stopped) throw new Error("Interrupted");
  };
  let port: number | undefined;
  let monitor: ReturnType<typeof setInterval> | undefined;
  try {
    const server = start("server");
    const deadline = Date.now() + 180000;
    while (!(await Bun.file(`${out}/ready.json`).exists())) {
      guard();
      if (await Bun.file(`${out}/server-pid.json`).exists()) server.pid = (await Bun.file(`${out}/server-pid.json`).json()).pid;
      if (server.child.exitCode !== null) throw new Error("Server setup failed; see server.stderr/summary");
      if (Date.now() > deadline) throw new Error("Server setup deadline exceeded");
      await Bun.sleep(100);
    }
    const ready = await Bun.file(`${out}/ready.json`).json();
    server.pid = ready.pid;
    port = ready.port;
    await mkdir(`${out}/node-2`);
    await writeFile(`${out}/node-2/config.json`, JSON.stringify({ options, out: `${out}/node-2`, primaryOut: out }));
    const second = start("server-2");
    const secondDeadline = Date.now() + 120000;
    while (!(await Bun.file(`${out}/node-2/ready.json`).exists())) {
      guard();
      if (await Bun.file(`${out}/node-2/server-pid.json`).exists())
        second.pid = (await Bun.file(`${out}/node-2/server-pid.json`).json()).pid;
      if (second.child.exitCode !== null || Date.now() > secondDeadline) throw new Error("Second server setup failed");
      await Bun.sleep(100);
    }
    const secondReady = await Bun.file(`${out}/node-2/ready.json`).json();
    second.pid = secondReady.pid;
    await writeFile(
      `${out}/ready.json`,
      JSON.stringify({ ...ready, ports: [ready.port, secondReady.port], pids: [ready.pid, secondReady.pid] }),
    );
    const client = start("clients");
    const clientPidDeadline = Date.now() + 10000;
    while (!(await Bun.file(`${out}/client-pid.json`).exists())) {
      guard();
      if (Date.now() > clientPidDeadline || client.child.exitCode !== null) throw new Error("Client startup failed");
      await Bun.sleep(100);
    }
    client.pid = (await Bun.file(`${out}/client-pid.json`).json()).pid;
    if (options.bounded) {
      const limits = await Promise.all(
        children.map(async (owned) => {
          const group = (await Bun.file(`/proc/${owned.pid}/cgroup`).text()).trim().split("::")[1];
          return {
            name: owned.name,
            pid: owned.pid,
            group,
            memoryMax: (await Bun.file(`/sys/fs/cgroup${group}/memory.max`).text()).trim(),
            cpuMax: (await Bun.file(`/sys/fs/cgroup${group}/cpu.max`).text()).trim(),
          };
        }),
      );
      await writeFile(`${out}/resources.json`, JSON.stringify(limits, null, 2));
    }
    const abort = Promise.withResolvers<never>();
    monitor = setInterval(() => {
      writeSample(`${out}/host.ndjson`, { at: Date.now(), load: loadavg() });
      try {
        guard();
      } catch (e) {
        abort.reject(e);
      }
    }, 1000);
    const code = await within(
      Promise.race([
        client.child.exited,
        abort.promise,
        server.child.exited.then((code) => {
          if (code) throw new Error("Server stopped before clients completed");
          return client.child.exited;
        }),
      ]),
      (options.seconds + 180) * 1000,
      "Clients",
    );
    if (code) {
      const artifact = Bun.file(`${out}/client-summary.json`);
      failure = (await artifact.exists()) ? (await artifact.json()).failure : `Client exit ${code}`;
    }
    await fetch(`http://127.0.0.1:${secondReady.port}/__load/stop`, { method: "POST", signal: AbortSignal.timeout(3000) }).catch(
      () => undefined,
    );
    await within(second.child.exited, 90000, "Second server cleanup");
    await fetch(`http://127.0.0.1:${port}/__load/stop`, { method: "POST", signal: AbortSignal.timeout(3000) }).catch(() => undefined);
    await within(server.child.exited, 90000, "Server cleanup");
  } catch (e) {
    failure = String(e);
  } finally {
    if (monitor) clearInterval(monitor);
    for (const owned of [...children].reverse()) {
      if (owned.child.exitCode !== null) continue;
      if (owned.pid) {
        try {
          process.kill(owned.pid, "SIGTERM");
        } catch {
          /* Worker already exited; reap its scope wrapper below. */
        }
      } else owned.child.kill("SIGTERM");
      await within(owned.child.exited, 30000, `${owned.name} termination`).catch(() => {
        if (owned.pid) {
          try {
            process.kill(owned.pid, "SIGKILL");
          } catch {}
        } else owned.child.kill("SIGKILL");
      });
      await owned.child.exited;
    }
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
  await uptime("end");
  const read = async (name: string) =>
    (await Bun.file(`${out}/${name}-summary.json`).exists()) ? Bun.file(`${out}/${name}-summary.json`).json() : null;
  const server = await read("server"),
    clients = await read("client");
  const secondServer = (await Bun.file(`${out}/node-2/server-summary.json`).exists())
    ? await Bun.file(`${out}/node-2/server-summary.json`).json()
    : null;
  failure ??= server?.failure ?? secondServer?.failure ?? clients?.failure;
  const stages = await report(out);
  const workloadPassed = !failure;
  const latencyTargetMet = clients?.crossNodePropagation?.p95Ms != null && clients.crossNodePropagation.p95Ms < 1000;
  if (workloadPassed && !latencyTargetMet) failure = "Propagation p95 target of < 1000 ms missed";
  const summary = {
    options,
    workloadPassed,
    status: failure ? "not-stable" : "passed",
    failure,
    server,
    secondServer,
    clients,
    stages,
    latencyTargetMet,
  };
  await writeFile(`${out}/summary.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ out, status: summary.status, failure, propagation: clients?.propagation, memory: server?.memory }));
  if (failure) process.exitCode = 1;
}
