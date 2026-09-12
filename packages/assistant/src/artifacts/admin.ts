import { sql } from "bun";
import { z } from "zod";
import { hasRole } from "@k2b/cloud/contracts";
import { ArtifactError, artifacts, user, type ArtifactIdentity } from "./service";

export function adminIdentity(identity: ArtifactIdentity): ArtifactIdentity {
  if (!hasRole(user(identity),"admin")) throw new ArtifactError("ACCESS_DENIED");
  return {...identity,administrative:true};
}
export const artifactAdmin = {
  async list(identity: ArtifactIdentity,page=1,search="") {
    adminIdentity(identity); z.number().int().min(1).max(100000).parse(page);
    z.string().max(120).parse(search);
    const rows=await sql<{id:string;title:string;kind:"app"|"script";files:number;kv:number;bytes:number;database:boolean;published:boolean;projects:string[]}[]>`
      SELECT a.id,a.title,a.kind,a.published_revision IS NOT NULL AS published,
        (SELECT count(*)::int FROM assistant.artifact_storage s WHERE s.artifact_id=a.id AND s.area='files') AS files,
        (SELECT count(*)::int FROM assistant.artifact_storage s WHERE s.artifact_id=a.id AND s.area='kv') AS kv,
        (SELECT coalesce(sum(bytes),0)::int FROM assistant.artifact_storage s WHERE s.artifact_id=a.id) AS bytes,
        EXISTS(SELECT 1 FROM assistant.artifact_databases d WHERE d.artifact_id=a.id) AS database,
        ARRAY(SELECT project_id::text FROM assistant.artifact_projects p WHERE p.artifact_id=a.id ORDER BY project_id) AS projects
      FROM assistant.artifacts a WHERE a.title ILIKE ${"%"+search+"%"}
      ORDER BY a.updated_at DESC,a.id LIMIT 31 OFFSET ${(page-1)*30}`;
    return {items:rows.slice(0,30),hasNext:rows.length>30,page};
  },
  async remove(id: string,identity: ArtifactIdentity) {
    return artifacts.remove(id,adminIdentity(identity));
  },
};
