import { z } from "zod";
import { createBrowserCodeHost } from "./code-host-browser";
import { hostIpc } from "./code-host-ipc";

const Decision = z.object({ approved: z.boolean(), remember: z.literal("always").optional() });
export function startCliCodeHostProcess() {
  let host: Awaited<ReturnType<typeof createBrowserCodeHost>> | undefined;
  let starting: ReturnType<typeof createBrowserCodeHost> | undefined;
  const ipc = hostIpc(
    (message) => process.send!(message),
    async (request) => {
      if (request.operation === "start") {
        if (starting) throw new Error("CLI browser host already started");
        starting = createBrowserCodeHost({ origin: request.origin, token: request.token }, async (approval) =>
          Decision.parse(await ipc.request({ operation: "approve", approval })),
        );
        host = await starting;
        return null;
      }
      if (request.operation === "close") {
        await host?.close();
        return null;
      }
      if (request.operation === "health") {
        if (!host) throw new Error("Code host is not ready");
        await host.health();
        return null;
      }
      if (request.operation === "call" || request.operation === "execute") {
        if (!host) throw new Error("CLI browser host not started");
        return host[request.operation](request.call);
      }
      throw new Error("Unsupported CLI browser request");
    },
  );
  process.on("message", ipc.receive);
  process.on("disconnect", () => {
    ipc.close();
    void (
      starting?.then(
        (value) => value.close(),
        () => {},
      ) ?? Promise.resolve()
    ).finally(() => process.exit());
  });
}

if (import.meta.main) startCliCodeHostProcess();
