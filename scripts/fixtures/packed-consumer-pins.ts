export const packedSiblings = ["@k2b/ui", "@k2b/ssr"] as const;
type Sibling = (typeof packedSiblings)[number];
type SiblingValues = Record<Sibling, string>;
export type PackedConsumerMode = "workspace" | "release";

type ResolvedPin = { pin: string; spec: string; source: "npm" | "packed" };

export const resolvePackedConsumerPins = async (input: {
  pins: SiblingValues;
  workspaceVersions: SiblingValues;
  archives: SiblingValues;
  mode: PackedConsumerMode;
  isPublished: (name: Sibling, version: string) => Promise<boolean>;
}): Promise<Record<Sibling, ResolvedPin>> => {
  const resolvePin = async (name: Sibling): Promise<ResolvedPin> => {
    const pin = input.pins[name];
    if (input.mode === "workspace") return { pin, spec: input.archives[name], source: "packed" };
    if (await input.isPublished(name, pin)) return { pin, spec: pin, source: "npm" };
    const workspaceVersion = input.workspaceVersions[name];
    if (pin === workspaceVersion) return { pin, spec: input.archives[name], source: "packed" };
    throw new Error(`${name}@${pin} is neither on npm nor published by this release (workspace version: ${workspaceVersion})`);
  };
  return { "@k2b/ui": await resolvePin("@k2b/ui"), "@k2b/ssr": await resolvePin("@k2b/ssr") };
};
