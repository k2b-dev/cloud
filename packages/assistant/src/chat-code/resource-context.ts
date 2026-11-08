import { ArtifactError, type ArtifactIdentity } from "./identity";
export type RuntimeResource = { id: string; title: string; permission: string; internalId: string };
export type ResolveRuntimeResource = (id: string, identity: ArtifactIdentity) => Promise<RuntimeResource>;
export const noRuntimeResource: ResolveRuntimeResource = async () => {
  throw new ArtifactError("ACCESS_DENIED");
};
