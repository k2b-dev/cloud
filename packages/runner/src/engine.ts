import { chmod, chown, mkdtemp, readFile, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerConfig, RunnerJsonValue, RunnerLease, RunnerOutcome } from "@k2b/cloud/code/runner";
import { RunnerCallError } from "@k2b/cloud/code/runner";
import { z as schema } from "zod";
import { readBytes } from "./bridge";

/** Only bridge calls can leave a sandbox. No run token or app key crosses this interface. */
export type SandboxCall = (operation: string, input: RunnerJsonValue) => Promise<RunnerJsonValue>;
/** Execution seam for C14 attacks and C17 simulations. load does not execute user code. */
export interface RunnerEngine {
  load(lease: RunnerLease, source: string, config: RunnerConfig, call: SandboxCall, signal: AbortSignal): Promise<void>;
  run(lease: RunnerLease, signal: AbortSignal): Promise<RunnerOutcome>;
  kill(runId: string): Promise<void>;
  close(): Promise<void>;
}
type Loaded = {
  lease: RunnerLease;
  source: string;
  config: RunnerConfig;
  call: SandboxCall;
  signal: AbortSignal;
  calls: number;
  group?: Group;
};
type Group = {
  process: Bun.Subprocess<"ignore", "pipe", "ignore">;
  socket: string;
  directory: string;
  server: ReturnType<typeof Bun.serve>;
  watchdog: ReturnType<typeof setInterval>;
  lastPing: number;
  checking: boolean;
  runs: Set<string>;
  outcome?: RunnerOutcome;
  closing?: Promise<void>;
  retire: () => void;
};
const CallSchema = schema.object({ runId: schema.string(), operation: schema.string().min(1), input: schema.json() }).strict();

// Never reuse identities within this supervisor, including across engine instances.
let nextUid = 20000;

/** One workerd process per organization and trust tier, independent of the number of replicas. */
export class WorkerdEngine implements RunnerEngine {
  #loaded = new Map<string, Loaded>();
  #groups = new Map<string, Promise<Group>>();
  constructor(readonly executable?: string) {}
  async load(lease: RunnerLease, source: string, config: RunnerConfig, call: SandboxCall, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.#loaded.has(lease.runId)) throw new Error("runner_already_loaded");
    this.#loaded.set(lease.runId, { lease, source, config, call, signal, calls: 0 });
  }
  async #spawn(config: RunnerConfig, retire: () => void): Promise<Group> {
    if (process.platform !== "linux" || process.getuid?.() !== 0) throw new Error("runner_isolation_requires_root");
    if (nextUid > 0x7fffffff) throw new Error("runner_isolation_uid_exhausted");
    const uid = nextUid++;
    const directory = await mkdtemp(join(tmpdir(), "cloud-workerd-"));
    const socket = join(directory, "workerd.sock");
    const bridgeSocket = join(directory, "bridge.sock");
    const capability = crypto.randomUUID();
    const members = new Set<string>();
    let server: Group["server"] | undefined;
    let child: Group["process"] | undefined;
    try {
      server = Bun.serve({
        unix: bridgeSocket,
        maxRequestBodySize: config.bridgeBytes,
        fetch: async (request, server) => {
          server.timeout(request, 0);
          if (request.method !== "POST" || new URL(request.url).pathname !== "/call" || request.headers.get("Authorization") !== capability)
            return new Response(null, { status: 403 });
          try {
            const bytes = await readBytes(new Response(request.body), config.bridgeBytes, request.signal);
            const call = CallSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
            const loaded = this.#loaded.get(call.runId);
            if (!members.has(call.runId) || !loaded || loaded.signal.aborted) return new Response(null, { status: 409 });
            // Reject overload immediately; there is no unbounded per-worker queue of HTTP calls.
            if (loaded.calls >= config.bridgeConcurrency) return Response.json({ ok: false, error: { code: "runner_bridge_busy" } });
            loaded.calls++;
            let result: RunnerJsonValue;
            try {
              result = await loaded.call(call.operation, call.input);
            } finally {
              loaded.calls--;
            }
            const body = JSON.stringify({ ok: true, data: result });
            if (Buffer.byteLength(body) > config.bridgeBytes) throw new Error("runner_call_too_large");
            return new Response(body, { headers: { "Content-Type": "application/json" } });
          } catch (error) {
            return Response.json({
              ok: false,
              error: { code: error instanceof RunnerCallError ? error.code : "runner_bridge_unavailable" },
            });
          }
        },
      });
      await chown(directory, uid, uid);
      // The enclosing 0700 directory admits only this group's UID and the supervisor.
      await chmod(bridgeSocket, 0o666);
      await Bun.write(join(directory, "host.js"), Bun.file(join(import.meta.dir, "assets/host.js")));
      await Bun.write(
        join(directory, "config.capnp"),
        `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "host", worker = (
      compatibilityDate = "2026-10-01", compatibilityFlags = ["experimental"],
      modules = [(name = "host.js", esModule = embed "host.js")],
      bindings = [(name = "LOADER", workerLoader = ()),
        (name = "BRIDGE", service = "bridge"), (name = "CAPABILITY", text = ${JSON.stringify(capability)})],
      globalOutbound = (name = "denied")
    )),
    (name = "bridge", external = (address = "unix:${bridgeSocket}", http = ())),
    (name = "denied", network = (allow = []))
  ],
  sockets = [(name = "http", address = "unix:${socket}", http = (), service = "host")]
);`,
      );
      // The workerd child has no environment, including no app key or Core origin.
      const executable =
        this.executable ?? (import.meta.path.endsWith(".ts") ? (await import("workerd")).default : join(import.meta.dir, "workerd"));
      child = Bun.spawn(
        [
          join(import.meta.dir, "runner-isolate"),
          String(uid),
          executable,
          "serve",
          "--experimental",
          "--control-fd=1",
          join(directory, "config.capnp"),
        ],
        {
          env: {},
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
        },
      );
      const reader = child.stdout.getReader();
      let readyTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            let text = "";
            while (text.length < 4096) {
              const chunk = await reader.read();
              if (chunk.done) break;
              text += new TextDecoder().decode(chunk.value);
              const line = text.split("\n")[0];
              if (line && text.includes("\n")) {
                schema
                  .object({ event: schema.literal("listen"), socket: schema.literal("http") })
                  .passthrough()
                  .parse(JSON.parse(line));
                return;
              }
            }
            throw new Error("runner_workerd_start_failed");
          })(),
          new Promise<never>((_, reject) => {
            readyTimer = setTimeout(() => reject(new Error("runner_workerd_start_timeout")), config.transportMs);
          }),
        ]);
      } finally {
        clearTimeout(readyTimer);
        void reader.cancel().catch(() => undefined);
      }
      const group: Group = {
        process: child,
        directory,
        server,
        socket,
        lastPing: performance.now(),
        checking: false,
        runs: members,
        retire,
        watchdog: setInterval(() => {
          void this.#check(group, config);
        }, 100),
      };
      return group;
    } catch {
      if (child) {
        child.kill("SIGKILL");
        await child.exited;
      }
      await server?.stop(true);
      await this.#remove(directory);
      throw new Error("runner_workerd_start_failed");
    }
  }
  async #check(group: Group, config: RunnerConfig) {
    if (group.closing) return;
    if (performance.now() - group.lastPing >= 1000) {
      await this.#terminate(group, "stalled");
      return;
    }
    try {
      if (process.platform === "linux") {
        const status = await readFile(`/proc/${group.process.pid}/status`, "utf8");
        const rss = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) * 1024;
        if (rss > config.processMemoryBytes) {
          await this.#terminate(group, "memory_limit");
          return;
        }
      }
    } catch {
      /* A dead child also fails the independent ping budget. */
    }
    if (group.checking || group.closing) return;
    group.checking = true;
    try {
      const response = await fetch("http://workerd/ping", { unix: group.socket, signal: AbortSignal.timeout(1000), timeout: false });
      await response.body?.cancel();
      if (response.ok) group.lastPing = performance.now();
    } catch {
      /* The independent 100ms tick enforces the stall budget. */
    } finally {
      group.checking = false;
    }
  }
  async #remove(directory: string) {
    await Promise.all(
      ["host.js", "config.capnp", "workerd.sock", "bridge.sock"].map((file) => unlink(join(directory, file)).catch(() => undefined)),
    );
    await rmdir(directory).catch(() => undefined);
  }
  async #terminate(group: Group, outcome: RunnerOutcome) {
    if (!group.closing) {
      group.retire();
      group.outcome = outcome;
      clearInterval(group.watchdog);
      group.closing = (async () => {
        group.process.kill("SIGKILL");
        await group.process.exited;
        await group.server.stop(true);
        await this.#remove(group.directory);
      })();
    }
    await group.closing;
  }
  async run(lease: RunnerLease, signal: AbortSignal): Promise<RunnerOutcome> {
    const loaded = this.#loaded.get(lease.runId);
    if (!loaded) throw new Error("runner_not_loaded");
    const key = JSON.stringify([lease.organizationId, lease.trustTier]);
    let pending = this.#groups.get(key);
    if (!pending) {
      pending = this.#spawn(loaded.config, () => {
        if (this.#groups.get(key) === pending) this.#groups.delete(key);
      });
      this.#groups.set(key, pending);
    }
    let group: Group;
    try {
      group = await pending;
    } catch {
      if (this.#groups.get(key) === pending) this.#groups.delete(key);
      throw new Error("runner_workerd_start_failed");
    }
    if (group.closing) {
      return this.run(lease, signal);
    }
    if (this.#loaded.get(lease.runId) !== loaded || signal.aborted) {
      if (group.runs.size === 0) await this.#terminate(group, "failed");
      return "failed";
    }
    loaded.group = group;
    group.runs.add(lease.runId);
    try {
      signal.throwIfAborted();
      const response = await fetch("http://workerd/run", {
        unix: group.socket,
        method: "POST",
        body: JSON.stringify({ runId: lease.runId, source: loaded.source, entrypoint: lease.entrypoint, input: lease.input }),
        signal,
        timeout: false,
      });
      await response.body?.cancel();
      return response.ok ? "succeeded" : "failed";
    } catch {
      return group.outcome ?? "failed";
    }
  }
  async kill(runId: string) {
    const loaded = this.#loaded.get(runId);
    this.#loaded.delete(runId);
    const group = loaded?.group;
    if (!group) return;
    group.runs.delete(runId);
    if (group.runs.size === 0) {
      await this.#terminate(group, "failed");
    }
  }
  async close() {
    for (const pending of this.#groups.values()) {
      const group = await pending.catch(() => undefined);
      if (group) await this.#terminate(group, "failed");
    }
    this.#groups.clear();
    this.#loaded.clear();
  }
}
