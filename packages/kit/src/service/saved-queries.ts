import { sql } from "bun";
import { requireProject, ProjectError, type Identity } from "./index";
import { QueryId, QueryInput, QueryUpdate, QueryRevision, QueryPage, type SavedQuery } from "../saved-queries";
type Row = { id: string; name: string; sql: string; revision: number; updated_at: Date };
const present = (r: Row): SavedQuery => ({
  id: r.id,
  name: r.name,
  sql: r.sql,
  revision: r.revision,
  updatedAt: r.updated_at.toISOString(),
});
export const savedQueries = {
  async list(id: string, page: number, identity: Identity, name?: string) {
    QueryPage.parse({ page, name });
    return sql.begin(async (db) => {
      const { row } = await requireProject(db, id, identity, "write");
      const rows = await db<
        Omit<Row, "sql">[]
      >`SELECT id,name,revision,updated_at FROM kit.saved_queries WHERE project_id=${row.id}::uuid AND (${name ?? null}::text IS NULL OR name=${name ?? null}) ORDER BY name,id LIMIT 51 OFFSET ${(page - 1) * 50}`;
      return {
        items: rows.slice(0, 50).map((r) => ({ id: r.id, name: r.name, revision: r.revision, updatedAt: r.updated_at.toISOString() })),
        page,
        hasNext: rows.length > 50,
      };
    });
  },
  async get(id: string, queryId: string, identity: Identity) {
    QueryId.parse(queryId);
    return sql.begin(async (db) => {
      const { row } = await requireProject(db, id, identity, "write");
      const [query] = await db<Row[]>`SELECT * FROM kit.saved_queries WHERE project_id=${row.id}::uuid AND id=${queryId}::uuid`;
      if (!query) throw new ProjectError(404, "NOT_FOUND");
      return present(query);
    });
  },
  async create(id: string, input: unknown, identity: Identity) {
    const next = QueryInput.parse(input);
    return sql.begin(async (db) => {
      const { row } = await requireProject(db, id, identity, "admin", true);
      const duplicate = await db`SELECT id FROM kit.saved_queries WHERE project_id=${row.id}::uuid AND name=${next.name} LIMIT 1`;
      if (duplicate.length) throw new ProjectError(409, "REVISION_CONFLICT");
      const [query] = await db<
        Row[]
      >`INSERT INTO kit.saved_queries(project_id,name,sql) VALUES(${row.id}::uuid,${next.name},${next.sql}) RETURNING *`;
      return present(query!);
    });
  },
  async update(id: string, queryId: string, input: unknown, identity: Identity) {
    QueryId.parse(queryId);
    const next = QueryUpdate.parse(input);
    return sql.begin(async (db) => {
      const { row } = await requireProject(db, id, identity, "admin", true);
      const duplicate = await db`SELECT id FROM kit.saved_queries WHERE project_id=${row.id}::uuid AND name=${next.name} AND id<>${queryId}::uuid LIMIT 1`;
      if (duplicate.length) throw new ProjectError(409, "REVISION_CONFLICT");
      const [query] = await db<
        Row[]
      >`UPDATE kit.saved_queries SET name=${next.name},sql=${next.sql},revision=revision+1,updated_at=now() WHERE project_id=${row.id}::uuid AND id=${queryId}::uuid AND revision=${next.revision} RETURNING *`;
      if (!query) throw new ProjectError(409, "REVISION_CONFLICT");
      return present(query);
    });
  },
  async delete(id: string, queryId: string, input: unknown, identity: Identity) {
    QueryId.parse(queryId);
    const { revision } = QueryRevision.parse(input);
    return sql.begin(async (db) => {
      const { row } = await requireProject(db, id, identity, "admin", true);
      const deleted =
        await db`DELETE FROM kit.saved_queries WHERE project_id=${row.id}::uuid AND id=${queryId}::uuid AND revision=${revision} RETURNING id`;
      if (!deleted.length) throw new ProjectError(409, "REVISION_CONFLICT");
      return { deleted: true };
    });
  },
};
