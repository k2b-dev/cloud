import type { RequestActor } from "@k2b/cloud/server";
import { audit } from "@k2b/cloud/services";
import { sql } from "bun";
import type { Area, BaseKind } from "../contracts";
export type Binding = {
  id: string;
  lifecycle: "active" | "provisioning" | "retired" | "archived" | "deleted";
  area: Area;
  kind: BaseKind;
  identity_id: string;
  identity_name: string;
  root: string;
  path: string;
  uid_number: number | null;
  gid_number: number | null;
};
export type NewBinding = Omit<Binding, "id" | "lifecycle">;
export const bindings = {
  async find(candidate: NewBinding): Promise<Binding[]> {
    return sql<
      Binding[]
    >`SELECT id,lifecycle,area,kind,identity_id,identity_name,root,path,uid_number::double precision AS uid_number,gid_number::double precision AS gid_number FROM filesv2.bases WHERE (root=${candidate.root} AND path=${candidate.path})
      OR (area=${candidate.area} AND kind=${candidate.kind} AND identity_id=${candidate.identity_id})`;
  },
  async claim(candidate: NewBinding, context?: { actor: RequestActor; requestId?: string | null; via?: string }): Promise<Binding[]> {
    await sql.begin(async (tx) => {
      const [created] = await tx<
        { id: string }[]
      >`INSERT INTO filesv2.bases (area,kind,identity_id,identity_name,root,path,uid_number,gid_number)
        VALUES (${candidate.area},${candidate.kind},${candidate.identity_id},${candidate.identity_name},${candidate.root},${candidate.path},${candidate.uid_number},${candidate.gid_number})
        ON CONFLICT DO NOTHING RETURNING id`;
      if (created && context) {
        const user = context.actor.kind === "user" ? context.actor.user : context.actor.delegatedUser;
        await audit.record(
          {
            action: "filesv2.adopt",
            outcome: "allowed",
            actor: { userId: user?.id, uid: user?.uid },
            target: { type: "filesv2.directory", id: created.id, label: candidate.path },
            requestId: context.requestId,
            metadata: { area: candidate.area, root: candidate.root, via: context.via ?? "system" },
          },
          tx,
        );
      }
    });
    return this.find(candidate);
  },
  async byId(id: string): Promise<Binding | null> {
    const [row] = await sql<
      Binding[]
    >`SELECT id,lifecycle,area,kind,identity_id,identity_name,root,path,uid_number::double precision AS uid_number,gid_number::double precision AS gid_number FROM filesv2.bases WHERE id=${id}::uuid`;
    return row ?? null;
  },
  async path(root: string, path: string): Promise<Binding | null> {
    const rows = await sql<
      Binding[]
    >`SELECT id,lifecycle,area,kind,identity_id,identity_name,root,path,uid_number::double precision AS uid_number,gid_number::double precision AS gid_number FROM filesv2.bases WHERE root=${root} AND path=${path}`;
    return rows[0] ?? null;
  },
};
