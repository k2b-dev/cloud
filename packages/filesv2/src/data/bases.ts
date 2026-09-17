import { sql } from "bun";
import type { Area, BaseKind } from "../contracts";
export type Binding = {
  id: string;
  area: Area;
  kind: BaseKind;
  identity_id: string;
  identity_name: string;
  root: string;
  path: string;
  uid_number: number | null;
  gid_number: number | null;
};
export type NewBinding = Omit<Binding, "id">;
export const bindings = {
  async find(candidate: NewBinding): Promise<Binding[]> {
    return sql<
      Binding[]
    >`SELECT id,area,kind,identity_id,identity_name,root,path,uid_number::double precision AS uid_number,gid_number::double precision AS gid_number FROM filesv2.bases WHERE (root=${candidate.root} AND path=${candidate.path})
      OR (area=${candidate.area} AND kind=${candidate.kind} AND identity_id=${candidate.identity_id})`;
  },
  async claim(candidate: NewBinding): Promise<Binding[]> {
    await sql`INSERT INTO filesv2.bases (area,kind,identity_id,identity_name,root,path,uid_number,gid_number)
      VALUES (${candidate.area},${candidate.kind},${candidate.identity_id},${candidate.identity_name},${candidate.root},${candidate.path},${candidate.uid_number},${candidate.gid_number})
      ON CONFLICT DO NOTHING`;
    return this.find(candidate);
  },
  async path(root: string, path: string): Promise<Binding | null> {
    const rows = await sql<
      Binding[]
    >`SELECT id,area,kind,identity_id,identity_name,root,path,uid_number::double precision AS uid_number,gid_number::double precision AS gid_number FROM filesv2.bases WHERE root=${root} AND path=${path}`;
    return rows[0] ?? null;
  },
};
