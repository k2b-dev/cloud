import { fileURLToPath } from "node:url";
import type { AiFrontendToolHandler } from "@k2b/cloud/ai/solid";
import type { CloudCliContext } from "@k2b/cloud/cli";
import type { CapabilityDecision, CodeApproval } from "../artifacts/runtime/capabilities";
import { createCodeHostHttp } from "./code-host-http";
import { hostIpc } from "./code-host-ipc";

/** Hidden `cld assistant` command that runs the code host in a child process. */
export const CODE_HOST_COMMAND = "code-host";

/**
 * The command that starts the code host child. Inside `cld` this module is a
 * bundled plugin, so the child is `cld assistant code-host` on the running
 * `cld`: the compiled binary itself, or `bun <entry>` when `cld` runs from
 * source. Loaded from source (tests, dev), the child runs the sibling file.
 */
const codeHostCommand = (): string[] => {
  if (import.meta.url.endsWith(".ts")) return [process.execPath, fileURLToPath(new URL("./code-host-process.ts", import.meta.url))];
  const self = Bun.main.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, Bun.main];
  return [...self, "assistant", CODE_HOST_COMMAND];
};

type Call = Parameters<AiFrontendToolHandler>[0];

// Each host owns one Bun process and one browser. Bun's child_process pipe
// finalizers must never outlive a browser and close a replacement's descriptors.
// Credentials and approval decisions stay in this parent CLI process.
export async function createCliCodeHost(
  ctx: Pick<CloudCliContext, "fetch">,
  approve?: (request: CodeApproval) => Promise<CapabilityDecision>,
  options?: { entry?: string; unattended?: boolean },
) {
  const http = createCodeHostHttp(ctx);
  const ipc = hostIpc(
    (message) => child.send(message),
    async (request) => {
      if (request.operation !== "approve") throw new Error("Unsupported CLI browser request");
      if (!approve)
        throw new Error(
          "Capability requires approval. Use an interactive Assistant CLI chat or explicitly allow this capability with --approve.",
        );
      return approve(request.approval);
    },
  );
  const command = options?.entry ? [process.execPath, options.entry] : codeHostCommand();
  const child = (() => {
    try {
      return Bun.spawn(command, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "inherit",
        serialization: "advanced",
        ipc: (message) => ipc.receive(message),
      });
    } catch (error) {
      http.close();
      ipc.close();
      throw error;
    }
  })();
  void child.exited.then(() => {
    http.close();
    ipc.close(new Error("CLI browser host exited; no operation was replayed"));
  });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      http.close();
      const force = setTimeout(() => child.kill(), 5000);
      try {
        if (child.exitCode === null) await ipc.request({ operation: "close" }).catch(() => {});
        ipc.close();
        child.disconnect();
        await child.exited;
      } finally {
        clearTimeout(force);
      }
    })());
  // Startup shares the runtime's 45-second operation budget. A stalled child
  // must not keep a server tool waiting forever before runtime deadlines exist.
  const startupDeadline = setTimeout(() => {
    ipc.close(new Error("Code host startup exceeded 45 seconds; no operation was executed"));
    child.kill();
  }, 45_000);
  try {
    await ipc.request({ operation: "start", origin: http.origin, token: http.token, unattended: options?.unattended });
    return {
      health: async () => {
        // Match the host bridge's network deadline. Check the browser event
        // loop as well as IPC so a frozen Chromium cannot look healthy.
        const deadline = setTimeout(() => {
          ipc.close(new Error("Code host heartbeat was lost; no operation was replayed"));
          child.kill();
        }, 10_000);
        try {
          await ipc.request({ operation: "health" });
        } finally {
          clearTimeout(deadline);
        }
      },
      execute: (call: Call) => ipc.request({ operation: "execute", call }),
      call: (call: Call) => ipc.request({ operation: "call", call }),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  } finally {
    clearTimeout(startupDeadline);
  }
}

const hosts = new WeakMap<CloudCliContext, ReturnType<typeof createCliCodeHost>>();
export function cliCodeHost(ctx: CloudCliContext, approve?: (request: CodeApproval) => Promise<CapabilityDecision>) {
  let host = hosts.get(ctx);
  if (!host) {
    host = createCliCodeHost(ctx, approve);
    hosts.set(ctx, host);
  }
  return host;
}
export async function closeCliCodeHost(ctx: CloudCliContext) {
  const host = hosts.get(ctx);
  hosts.delete(ctx);
  if (host)
    await host.then(
      (value) => value.close(),
      () => {},
    );
}
