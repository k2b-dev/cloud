/// <reference path="../../../runner/src/workerd.d.ts" />
import { createContext, runInContext } from "node:vm";
import type { ChatRunInput } from "@k2b/cloud/code/chat-run";
import type { RunnerBridge, RunnerJobLease } from "@k2b/cloud/code/runner";
import type { RunnerEngine, SandboxCall } from "../../../runner/src/engine";
import { Runner } from "../../../runner/src/runner";
import { config } from "../../../runner/test/fixtures";
import { handleRunnerMessage } from "./runner-code-host";
import type { RuntimeHooks } from "./runtime/host";
export async function runChatRunnerFixture(input: ChatRunInput, hooks: RuntimeHooks, signal: AbortSignal) {
  const NOW = Date.now();
  const job: RunnerJobLease = {
    kind: "chat",
    jobId: "44444444-4444-4444-8444-444444444444",
    generation: 1,
    leaseKey: "a".repeat(64),
    deadlineAt: NOW + 10_000,
    leaseExpiresAt: NOW + 10_000,
    heartbeatMs: 1000,
    inputBytes: 8 * 1024 * 1024,
    outputBytes: 2 * 1024 * 1024,
  };
  let bridgeCall: SandboxCall;
  let source = "";
  let modules: Record<string, string> = {};
  const engine: RunnerEngine = {
    load: async (_lease, bundle, _config, call, _signal, extra) => {
      source = bundle;
      bridgeCall = call;
      modules = extra ?? {};
    },
    run: async (lease, leaseSignal) => {
      const stopped = AbortSignal.any([signal, leaseSignal]);
      stopped.throwIfAborted();
      const context = createContext({
        console: { ...console },
        crypto,
        Blob,
        File,
        Response,
        Request,
        Headers,
        TextEncoder,
        TextDecoder,
        URL,
        AbortController,
        setTimeout,
        clearTimeout,
        atob,
        btoa,
      });
      // The trusted prelude is one ESM export; user modules are already bundled by the real compiler.
      const executable = source.replace(/export\{(\w+) as run\};?/, "globalThis.fixtureRun=$1;");
      runInContext(executable, context, {
        importModuleDynamically: async (specifier) => {
          const code = modules[String(specifier).replace(/^\.\//, "")];
          if (!code) throw new Error("Unknown runtime module");
          return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
        },
      });
      const run = Reflect.get(context, "fixtureRun");
      // Runner.stop() drains accepted work. Model the native engine's abort
      // behavior too, so closing a host can reclaim a deliberately pending script.
      let abort: () => void = () => {};
      try {
        await Promise.race([
          run(lease.input, { call: bridgeCall }),
          new Promise<never>((_, reject) => {
            abort = () => reject(stopped.reason);
            stopped.addEventListener("abort", abort, { once: true });
            if (stopped.aborted) abort();
          }),
        ]);
      } finally {
        stopped.removeEventListener("abort", abort);
      }
      return "succeeded";
    },
    kill: async () => {},
    close: async () => {},
  };
  let dispatched = false;
  const bridge: RunnerBridge = {
    configure: async () => ({ ...config, bundleBytes: 4 * 1024 * 1024 }),
    fetch: async (_, stopped) => {
      if (!dispatched) {
        dispatched = true;
        return { runs: [], jobs: [job] };
      }
      if (!stopped.aborted) await new Promise<void>((resolve) => stopped.addEventListener("abort", () => resolve(), { once: true }));
      return { runs: [] };
    },
    jobInput: async () => JSON.stringify({ kind: "chat", ...input }),
    jobHeartbeat: async () => ({ leaseExpiresAt: NOW + 10_000 }),
    jobCall: async (call) => {
      try {
        return { ok: true, value: await handleRunnerMessage(call.operation, call.input, hooks, signal) };
      } catch (error) {
        return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } };
      }
    },
    jobComplete: async (result) => {
      runner.stop();
      if (!signal.aborted && (result.result.kind !== "chat" || result.result.outcome !== "succeeded"))
        hooks.error(JSON.stringify(result.result));
    },
    bundle: async () => {
      throw new Error("Chat jobs must not fetch a lasting-Code bundle");
    },
    heartbeat: async () => {
      throw new Error("Unexpected production heartbeat");
    },
    complete: async () => {},
    call: async () => {
      throw new Error("Chat uses the turn mailbox");
    },
  };
  const runner = new Runner(bridge, engine);
  const stop = () => runner.stop();
  signal.addEventListener("abort", stop, { once: true });
  try {
    await runner.start();
  } finally {
    runner.stop();
    signal.removeEventListener("abort", stop);
  }
}
