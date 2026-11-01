import type { ResourcePrincipal } from "../contracts/capabilities";
import { resolveResourceReaders } from "../services/identity/resource-readers";

/** Apply the same current-account rules as provider-owned readability checks. */
export const activeResourcePrincipals = async (principals: ResourcePrincipal[]): Promise<ResourcePrincipal[]> =>
  (await resolveResourceReaders(principals)).map((reader) => reader.principal);
