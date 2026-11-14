import { parseCodeToolInput } from "@k2b/cloud/ai/browser";
import type { AiFrontendToolHandler } from "@k2b/cloud/ai/solid";
import { onCleanup } from "solid-js";
import { z } from "zod";
import { chatCodeRequest } from "./client";
import { openSecretsDialog } from "./SecretsDialog";

const Claim = z.discriminatedUnion("status", [
  z.object({ status: z.literal("execute") }),
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("interrupted") }),
  z.object({ status: z.literal("done"), result: z.json() }),
]);
export function createChatSecretRuntime() {
  const clientId = crypto.randomUUID(),
    abort = new AbortController();
  onCleanup(() => abort.abort());
  const code_secret: AiFrontendToolHandler = async ({ name, args, callId, turnId, conversationId }) => {
    try {
      const input = parseCodeToolInput(name, args);
      if (input.operation !== "secret") throw new Error("Chat secrets require the current conversation, without a Studio resource.");
      const call = { input, callId, turnId, conversationId, clientId };
      const request = (path: string, body: unknown) =>
        chatCodeRequest(path, body, AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]));
      let claim = Claim.parse(await request("claim", call));
      while (claim.status === "pending" && !abort.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        claim = Claim.parse(await request("claim", call));
      }
      if (claim.status === "done") return claim.result;
      if (claim.status !== "execute") throw new Error("Secret entry was interrupted. No entry was replayed.");
      const ownership = new AbortController();
      let leaseUntil = Date.now() + 120000,
        renewing = false;
      const heartbeat = setInterval(async () => {
        if (renewing || abort.signal.aborted) return;
        renewing = true;
        try {
          const claim = Claim.parse(await request("claim", call));
          leaseUntil = claim.status === "interrupted" ? 0 : Date.now() + 120000;
        } catch {
        } finally {
          renewing = false;
          if (Date.now() >= leaseUntil) ownership.abort();
        }
      }, 15000);
      let result: unknown;
      try {
        result = await openSecretsDialog(
          { conversationId },
          { name: input.name, origin: input.origin, header: input.header, prefix: input.prefix },
          AbortSignal.any([abort.signal, ownership.signal]),
        );
      } catch (error) {
        result = { failed: true, error: error instanceof Error ? error.message : String(error) };
      } finally {
        clearInterval(heartbeat);
      }
      await request("complete", { ...call, result });
      return result;
    } catch (error) {
      return { failed: true, error: (error instanceof Error ? error.message : String(error)).slice(0, 6000) };
    }
  };
  return { code_secret };
}
