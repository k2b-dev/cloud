import { sql } from "@k2b/cloud";
import type { ResolveRuntimeResource } from "../chat-code/resource-context";
import { ArtifactError, artifacts } from "./service";
export const resolveRuntimeResource: ResolveRuntimeResource = async (id, identity) => {
  const resource = await artifacts.get(id, identity);
  const [row] = await sql<{ id: string }[]>`SELECT id FROM assistant.artifacts WHERE short_id=${resource.id}`;
  if (!row) throw new ArtifactError("NOT_FOUND");
  return { ...resource, internalId: row.id };
};
