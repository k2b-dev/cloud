import { capabilityManifestEvolutionIssues, compileCapabilities } from "../_internal/capabilities";
import {
  type CapabilityDefinitions,
  type CapabilityExecutionContext,
  type CapabilityManifest,
  type CapabilityResult,
  CapabilitySemanticLinkSchema,
  CloudResourceRefSchema,
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

/** Check every resource-bearing success, including Actions, lists and nested resources. */
export const assertResourceOpenLinks = (result: CapabilityResult<unknown>, manifest: CapabilityManifest): void => {
  const linked = new Set<string>();
  const key = (ref: { type: string; id: string }) => JSON.stringify([ref.type, ref.id]);
  const readable = (ref: { type: string; id: string }) => {
    const type = manifest.types.find((type) => `${manifest.appId}.${type.localId}` === ref.type);
    return !type || Boolean(type.reader);
  };
  const open = (links: unknown): boolean =>
    Array.isArray(links) &&
    links.some((link: unknown) => {
      const parsed = CapabilitySemanticLinkSchema.safeParse(link);
      return parsed.success && parsed.data.rel === "open";
    });
  const hasOpen = open(result.links);
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if ("ref" in value) {
      const ref = CloudResourceRefSchema.safeParse(value.ref);
      if (ref.success && readable(ref.data)) {
        if (!("links" in value && open(value.links)) && !hasOpen) throw new Error(`Resource ${ref.data.type} must return an open link`);
        linked.add(key(ref.data));
      }
    }
    Object.values(value).forEach(visit);
  };
  visit(result.data);
  for (const ref of result.refs ?? []) {
    if (readable(ref) && !hasOpen && !linked.has(key(ref))) throw new Error(`Resource ${ref.type} must return an open link`);
  }
};

/** Apply the resource contract to every operation exercised by a provider's behavior tests. */
export const withResourceOpenLinkAssertions = <T extends CapabilityDefinitions>(appId: string, definitions: T): T => {
  const manifest = compileCapabilityManifest(appId, definitions);
  for (const operations of [definitions.queries, definitions.actions]) {
    for (const [id, operation] of Object.entries(operations ?? {})) {
      const run = operation.run;
      operation.run = async (input: unknown, context: CapabilityExecutionContext) => {
        const result = await run(input, context);
        if (result.ok) {
          try {
            assertResourceOpenLinks(result.data, manifest);
          } catch (error) {
            throw new Error(`${appId}.${id}: resource link contract failed`, { cause: error });
          }
        }
        return result;
      };
    }
  }
  return definitions;
};
