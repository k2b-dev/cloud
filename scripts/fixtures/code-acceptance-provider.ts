import { z } from "zod";
import {
  compileCapabilities,
  invokeCompiledCapability,
  reviewCompiledCapability,
  serializeCapabilityProviderResult,
} from "../../packages/cloud/src/_internal/capabilities";
import { createCodeOwnerRoutes } from "../../packages/cloud/src/_internal/code-owner";
import { type CapabilityDefinitions, CapabilityManifestSchema } from "../../packages/cloud/src/contracts";
import { bindAppEvents } from "../../packages/cloud/src/events/app-events";

/** Checked callable boundary for loading another app's fixture under its own tsconfig aliases. */
export const AcceptanceProviderSchema = z.object({
  manifest: CapabilityManifestSchema,
  authority: z.function({ input: [z.instanceof(Request)], output: z.promise(z.instanceof(Response)) }),
  invoke: z.function({ input: [z.unknown()], output: z.promise(z.instanceof(Response)) }),
  permission: z.function({ input: [z.unknown()], output: z.promise(z.enum(["none", "read", "write", "admin"])) }).optional(),
  grant: z.function({ input: [z.unknown()], output: z.promise(z.unknown()) }).optional(),
  revoke: z.function({ input: [z.unknown()], output: z.promise(z.unknown()) }).optional(),
  accessList: z.function({ input: [z.string()], output: z.promise(z.array(z.unknown())) }).optional(),
});
export type AcceptanceProvider = z.infer<typeof AcceptanceProviderSchema>;

/** Only delivery is replaced. The app's compiler, schemas, reviews and domain services execute. */
export function acceptanceProvider(appId: string, definitions: CapabilityDefinitions) {
  const compiled = compileCapabilities(appId, definitions);
  bindAppEvents(appId, definitions, compiled);
  const authority = createCodeOwnerRoutes(appId, definitions);
  return {
    manifest: compiled.manifest,
    authority: async (request: Request) => authority.fetch(request),
    async invoke(input: Omit<Parameters<typeof reviewCompiledCapability>[0], "compiled"> & { kind: "query" | "action"; review?: boolean }) {
      const params = { ...input, compiled };
      const result = input.review ? await reviewCompiledCapability(params) : await invokeCompiledCapability(params);
      const operation = input.kind === "action" ? compiled.actions.get(input.localId) : undefined;
      const serialized = serializeCapabilityProviderResult(result, {
        review: input.review === true,
        nonIdempotentAction: input.kind === "action" && operation?.manifest.idempotency === "none",
      });
      return new Response(serialized.body, { status: serialized.status, headers: { "content-type": "application/json" } });
    },
  };
}

/** Page loader seam for acceptance assertions against real Core query results. */
export { loadCodePage, targetKey } from "../../packages/cloud/src/ssr/code-page/load";
