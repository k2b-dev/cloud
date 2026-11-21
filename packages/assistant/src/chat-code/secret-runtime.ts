import type { AiFrontendToolHandler } from "@k2b/cloud/ai/solid";
import { importOnDemand } from "@k2b/cloud/browser/reload";
import { onCleanup } from "solid-js";
import type { SecretRequestController } from "./secret-request";

export function createChatSecretRuntime(
  options: { cards?: boolean; present?: (controller: SecretRequestController, callId: string) => void } = {},
) {
  const clientId = crypto.randomUUID(),
    abort = new AbortController();
  onCleanup(() => abort.abort());
  const code_secret: AiFrontendToolHandler = async (call) => {
    try {
      const loaded = await importOnDemand(() => import("./secret-runtime-entry"));
      if (loaded) return await loaded.secretRuntimeHandlers(clientId, abort, options).code_secret(call);
    } catch {
      /* An import failure must leave a visible tool failure without exception text. */
    }
    return { failed: true, error: "Secret entry could not be opened. No value was returned." };
  };
  return { code_secret };
}
