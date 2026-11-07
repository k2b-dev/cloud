export const packedSiblings = ["@k2b/ui", "@k2b/ssr", "@k2b/editor"] as const;
type Sibling = (typeof packedSiblings)[number];
type SiblingValues = Record<Sibling, string>;
export type PackedConsumerMode = "workspace" | "release";

type ResolvedPin = { pin: string; spec: string; source: "npm" | "packed"; sourceChanged?: true };

export const resolvePackedConsumerPins = async (input: {
  pins: SiblingValues;
  workspaceVersions: SiblingValues;
  archives: SiblingValues;
  mode: PackedConsumerMode;
  cloudPublished: boolean;
  publishedTypesMatch: (name: Sibling, version: string, archive: string) => Promise<boolean>;
  isPublished: (name: Sibling, version: string) => Promise<boolean>;
}): Promise<Record<Sibling, ResolvedPin>> => {
  const resolvePin = async (name: Sibling): Promise<ResolvedPin> => {
    const pin = input.pins[name];
    if (input.mode === "workspace") return { pin, spec: input.archives[name], source: "packed" };
    const workspaceVersion = input.workspaceVersions[name];
    if (await input.isPublished(name, pin)) {
      if (pin === workspaceVersion && !(await input.publishedTypesMatch(name, pin, input.archives[name]))) {
        if (!input.cloudPublished) {
          throw new Error(
            `${name}@${pin} source changed without a version bump; refresh a stale release PR or land a release-eligible fix/feat commit for this package before releasing Cloud`,
          );
        }
        // A sync can carry an already-published release manifest plus newer source.
        // Test that snapshot, without pretending npm contains its unreleased types.
        return { pin, spec: input.archives[name], source: "packed", sourceChanged: true };
      }
      return { pin, spec: pin, source: "npm" };
    }
    if (pin === workspaceVersion) return { pin, spec: input.archives[name], source: "packed" };
    throw new Error(`${name}@${pin} is neither on npm nor published by this release (workspace version: ${workspaceVersion})`);
  };
  return {
    "@k2b/ui": await resolvePin("@k2b/ui"),
    "@k2b/ssr": await resolvePin("@k2b/ssr"),
    "@k2b/editor": await resolvePin("@k2b/editor"),
  };
};
