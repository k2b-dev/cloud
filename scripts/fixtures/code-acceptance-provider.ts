import { z } from "zod";
import {
  compileCapabilities,
  invokeCompiledCapability,
  reviewCompiledCapability,
  serializeCapabilityProviderResult,
} from "../../packages/cloud/src/_internal/capabilities";
import { createCodeAccessAuthorityRoutes } from "../../packages/cloud/src/_internal/code-access-authority";
import { codeAccessBindings, listCodeAccess, removeCodeAccess, setCodeAccess } from "../../packages/cloud/src/code/access";
import {
  type CapabilityDefinitions,
  CapabilityManifestSchema,
  CodeAccessListDataSchema,
  CodeAccessSetDataSchema,
} from "../../packages/cloud/src/contracts";
import { bindAppEvents } from "../../packages/cloud/src/events/app-events";

/** Checked callable boundary for loading another app's fixture under its own tsconfig aliases. */
export const AcceptanceProviderSchema = z.object({
  manifest: CapabilityManifestSchema,
  authority: z.function({ input: [z.instanceof(Request)], output: z.promise(z.instanceof(Response)) }),
  invoke: z.function({ input: [z.unknown()], output: z.promise(z.instanceof(Response)) }),
  set: z.function({ input: [z.unknown()], output: z.promise(CodeAccessSetDataSchema) }),
  list: z.function({ input: [z.unknown()], output: z.promise(CodeAccessListDataSchema) }),
  remove: z.function({ input: [z.unknown()], output: z.promise(z.boolean()) }),
  permission: z.function({ input: [z.unknown()], output: z.promise(z.enum(["none", "read", "write", "admin"])) }).optional(),
  accessList: z.function({ input: [z.string()], output: z.promise(z.array(z.unknown())) }).optional(),
});
export type AcceptanceProvider = z.infer<typeof AcceptanceProviderSchema>;

/** Only delivery is replaced. The app's compiler, schemas, reviews and domain services execute. */
export function acceptanceProvider(appId: string, definitions: CapabilityDefinitions) {
  const compiled = compileCapabilities(appId, definitions);
  bindAppEvents(appId, definitions, compiled);
  const bindings = codeAccessBindings(appId, definitions);
  const authority = createCodeAccessAuthorityRoutes(appId, definitions);
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
    set: (params: {
      input: Parameters<typeof setCodeAccess>[2];
      context: Parameters<typeof setCodeAccess>[3];
      dependencies: Parameters<typeof setCodeAccess>[4];
    }) => setCodeAccess(appId, bindings, params.input, params.context, params.dependencies),
    list: (params: { principal: string; authority: Parameters<typeof listCodeAccess>[3] }) =>
      listCodeAccess(appId, bindings, params.principal, params.authority),
    remove: (params: { grantId: string; authority: Parameters<typeof removeCodeAccess>[3] }) =>
      removeCodeAccess(appId, bindings, params.grantId, params.authority),
  };
}

/** Page loader seam for acceptance assertions against real Core query results. */
export { loadCodePage, targetKey } from "../../packages/cloud/src/ssr/code-page/load";
