import {
  type CapabilityDefinitions,
  CapabilityManifestSchema,
  CodeAccessListDataSchema,
  CodeAccessSetDataSchema,
} from "@k2b/cloud/contracts";
import { z } from "zod";
import { compileCapabilities, invokeCompiledCapability, reviewCompiledCapability } from "../../packages/cloud/src/_internal/capabilities";
import { codeAccessBindings, listCodeAccess, removeCodeAccess, setCodeAccess } from "../../packages/cloud/src/code/access";

/** Checked callable boundary for loading another app's fixture under its own tsconfig aliases. */
export const AcceptanceProviderSchema = z.object({
  manifest: CapabilityManifestSchema,
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
  const bindings = codeAccessBindings(appId, definitions);
  return {
    manifest: compiled.manifest,
    async invoke(input: Omit<Parameters<typeof reviewCompiledCapability>[0], "compiled"> & { kind: "query" | "action"; review?: boolean }) {
      const params = { ...input, compiled };
      const result = input.review ? await reviewCompiledCapability(params) : await invokeCompiledCapability(params);
      return result.ok ? Response.json(result.data) : Response.json(result.error, { status: result.error.status });
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
