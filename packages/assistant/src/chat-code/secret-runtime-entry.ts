import { parseCodeToolInput } from "@k2b/cloud/ai/browser";
import type { AiFrontendToolHandler } from "@k2b/cloud/ai/solid";
import { importOnDemand } from "@k2b/cloud/browser/reload";
import { z } from "zod";
import { chatCodeRequest } from "./client";
import { openSecretsDialog } from "./SecretsDialog";
import type { SecretRequestController } from "./secret-request";

const Claim = z.discriminatedUnion("status", [
  z.object({ status: z.literal("execute") }),
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("interrupted") }),
  z.object({ status: z.literal("done"), result: z.json() }),
]);
const failed = () => ({ failed: true as const, error: "Secret entry was interrupted. No entry was replayed." });
/** The only output crossing into a tool result: no exception text or extra browser fields. */
const resultSchema = z.union([
  z.object({ configured: z.boolean(), name: z.string() }),
  z.object({ failed: z.literal(true), error: z.string(), guidance: z.string().optional() }),
]);

export function secretRuntimeHandlers(
  clientId: string,
  abort: AbortController,
  options: { cards?: boolean; present?: (controller: SecretRequestController, callId: string) => void },
) {
  const code_secret: AiFrontendToolHandler = async ({ name, args, callId, turnId, conversationId }) => {
    let controller: SecretRequestController | undefined;
    let unregister: (() => void) | undefined;
    let clearLease: (() => void) | undefined;
    try {
      const input = parseCodeToolInput(name, args);
      if (input.operation !== "secret") return failed();
      const call = { input, callId, turnId, conversationId, clientId };
      const request = (path: string, body: unknown) =>
        chatCodeRequest(path, body, AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]));
      let claim = Claim.parse(await request("claim", call));
      if (claim.status === "done") return resultSchema.parse(claim.result);
      if (claim.status === "interrupted") return failed();
      const ownership = new AbortController();
      let leaseUntil = Date.now() + 120000,
        renewing = false;
      // runtime-timer: browser lease heartbeat of secret entry already in flight; it must continue while maintenance drains work.
      const heartbeat =
        claim.status === "execute"
          ? setInterval(async () => {
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
            }, 15000)
          : undefined;
      const signal = AbortSignal.any([abort.signal, ownership.signal]);
      const expire = () => controller?.expire();
      signal.addEventListener("abort", expire, { once: true });
      clearLease = () => {
        if (heartbeat !== undefined) clearInterval(heartbeat);
        signal.removeEventListener("abort", expire);
      };
      // Keep controller, capability transport and card-only dependencies outside the initial workspace bundle.
      if (input.target || options.cards || options.present) {
        const loaded = await importOnDemand(async () => ({
          request: await import("./secret-request"),
          client: await import("./secret-request-client"),
        }));
        if (!loaded) return failed();
        controller = loaded.request.createSecretRequest(input, loaded.client.secretRequestPorts(input, conversationId, signal));
        await controller.start();
        if (signal.aborted) controller.expire();
        if (controller.state.state !== "unavailable") {
          if (claim.status === "pending") controller.held();
          unregister = loaded.request.registerSecretRequest({ conversationId, turnId, callId }, controller);
          options.present?.(controller, callId);
        }
      }
      while (claim.status === "pending" && !abort.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        claim = Claim.parse(await request("claim", call));
      }
      if (claim.status === "done") {
        const result = resultSchema.parse(claim.result);
        controller?.complete(result);
        return result;
      }
      if (claim.status !== "execute") return failed();
      let result: z.infer<typeof resultSchema>;
      try {
        if (signal.aborted) controller?.expire();
        result = resultSchema.parse(
          controller
            ? await controller.result
            : await openSecretsDialog(
                { conversationId },
                { name: input.name, origin: input.origin, header: input.header, prefix: input.prefix },
                signal,
              ),
        );
      } catch {
        result = failed();
      } finally {
        signal.removeEventListener("abort", expire);
      }
      await request("complete", { ...call, result });
      return result;
    } catch {
      return failed();
    } finally {
      clearLease?.();
      unregister?.();
      controller?.expire();
    }
  };
  return { code_secret };
}
