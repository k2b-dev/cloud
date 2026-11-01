import { getProcessApplicationId } from "../_internal/process-identity";
import { getCapability } from "../_internal/registry";
import { dispatchCapability } from "../api/capabilities";
import type { RequestAuthority } from "../server/middleware/auth";

/**
 * Core activation and rights-editor entry point, after owner/editor authorization.
 * Issues operation-bound Code access admission; never expose this helper as an AI,
 * MCP, generic capability, or sandbox transport. Target authority and set proofs
 * are still checked independently. Returns the ordinary capability HTTP envelope.
 */
export const invokeCodeAccess = (params: {
  request: Request;
  appId: string;
  operation: "set" | "list" | "rm";
  input: unknown;
  authority: RequestAuthority;
  locale?: string;
  review?: boolean;
}): Promise<Response> => {
  if (getProcessApplicationId() !== "core") throw new Error("Code access invocation is owned by Core");
  return dispatchCapability({
    request: params.request,
    appId: params.appId,
    kind: params.operation === "list" ? "queries" : "actions",
    capabilityId: `code.access.${params.operation}`,
    codeAccess: params.operation,
    input: params.input,
    authority: params.authority,
    locale: params.locale,
    review: params.review,
    origin: "app",
    callingAppId: "core",
  });
};

/** Core activation reads the complete registered manifest independently of the activating person's app-entry rights. */
export const readCodeActivationManifest = async (appId: string) => {
  if (getProcessApplicationId() !== "core") throw new Error("Code activation manifests are owned by Core");
  return (await getCapability(appId))?.manifest ?? null;
};
