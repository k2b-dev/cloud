import { capabilityManifestEvolutionIssues, compileCapabilities } from "../_internal/capabilities";
import {
  type CapabilityDefinitions,
  type CapabilityManifest,
  type CapabilityResult,
  CapabilitySemanticLinkSchema,
} from "../contracts/capabilities";

/** Compile and validate the public manifest an app would register at startup. */
export const compileCapabilityManifest = (appId: string, definitions: CapabilityDefinitions): CapabilityManifest =>
  compileCapabilities(appId, definitions).manifest;

/** Fail a provider compatibility test when a published local id changed incompatibly. */
export const assertCapabilityManifestEvolution = (previous: CapabilityManifest, next: CapabilityManifest): void => {
  const issues = capabilityManifestEvolutionIssues(previous, next);
  if (issues.length > 0) throw new Error(`Breaking Capability manifest evolution:\n- ${issues.join("\n- ")}`);
};

/** Assert that a reader result exposes a valid destination for its resource permalink. */
export const assertResourceOpenLink = (result: Pick<CapabilityResult<unknown>, "links">) => {
  const link = result.links?.find((link) => link.rel === "open");
  if (!link) throw new Error("Resource reader must return a top-level open link");
  return CapabilitySemanticLinkSchema.parse(link);
};
