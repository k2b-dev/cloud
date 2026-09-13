import type { CodeApproval, CapabilityDecision } from "../artifacts/runtime/capabilities";
import type { CloudCliContext } from "@k2b/cloud/cli";
import type { AiFrontendToolHandler } from "@k2b/cloud/ai/solid";
import { fileURLToPath } from "node:url";
import { hostIpc, hostHeaders } from "./code-host-ipc";

declare const __CLD_STANDALONE__: boolean;

type Call = Parameters<AiFrontendToolHandler>[0];

// Each host owns one Bun process and one browser. Bun's child_process pipe
// finalizers must never outlive a browser and close a replacement's descriptors.
// Credentials and approval decisions stay in this parent CLI process.
export async function createCliCodeHost(ctx: Pick<CloudCliContext, "fetch">, approve?: (request: CodeApproval) => Promise<CapabilityDecision>) {
  const lifetime = new AbortController();
  const ipc = hostIpc(message => child.send(message), async request => {
    if (request.operation === "approve") {
      if (!approve) throw new Error("Capability requires approval. Use an interactive Assistant CLI chat or explicitly allow this capability with --approve.");
      return approve(request.approval);
    }
    if (request.operation !== "fetch") throw new Error("Unsupported CLI browser request");
    const response = await ctx.fetch(request.path, { method: request.method, headers: request.headers,
      ...(request.body ? { body: request.body } : {}), signal: lifetime.signal });
    return { status: response.status, headers: hostHeaders(response.headers), body: await response.arrayBuffer() };
  });
  const entry = typeof __CLD_STANDALONE__ !== "undefined" && __CLD_STANDALONE__
    ? "--internal-code-host" : fileURLToPath(new URL("./code-host-process.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, entry], {
    stdin: "ignore", stdout: "ignore", stderr: "inherit", serialization: "advanced",
    ipc: message => ipc.receive(message),
  });
  void child.exited.then(() => {
    lifetime.abort();
    ipc.close(new Error("CLI browser host exited; no operation was replayed"));
  });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    lifetime.abort();
    const force = setTimeout(() => child.kill(), 5000);
    try {
      if (child.exitCode === null) await ipc.request({ operation: "close" }).catch(() => {});
      ipc.close();
      child.disconnect();
      await child.exited;
    } finally { clearTimeout(force); }
  })();
  try {
    await ipc.request({ operation: "start" });
    return {
      execute: (call: Call) => ipc.request({ operation: "execute", call }),
      call: (call: Call) => ipc.request({ operation: "call", call }),
      close,
    };
  } catch (error) { await close(); throw error; }
}

const hosts = new WeakMap<CloudCliContext, ReturnType<typeof createCliCodeHost>>();
export function cliCodeHost(ctx: CloudCliContext,approve?:(request:CodeApproval)=>Promise<CapabilityDecision>) {
  let host = hosts.get(ctx);
  if (!host) { host = createCliCodeHost(ctx,approve); hosts.set(ctx, host); }
  return host;
}
export async function closeCliCodeHost(ctx: CloudCliContext) {
  const host = hosts.get(ctx);
  hosts.delete(ctx);
  if (host) await host.then(value => value.close(), () => {});
}
