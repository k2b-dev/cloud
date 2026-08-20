import { sql } from "bun";
import { type TableMutationPolicy, TableMutationPolicySchema } from "../contracts";

export type TableAdminOverviewFilters = {
  q?: string;
  kind?: "all" | "stored" | "combined";
  history?: "all" | "off" | "preparing" | "active";
  finalization?: "all" | "off" | "direct" | "fourEyes";
  page?: number;
  perPage?: number;
};

export type TableAdminOverviewItem = {
  id: string;
  name: string;
  kind: "stored" | "combined";
  fieldCount: number;
  indexedFieldCount: number;
  uniqueFieldCount: number;
  durableHistory: "off" | "preparing" | "active";
  finalizationMode: "off" | "direct" | "fourEyes";
  approverGroupId: string | null;
  approverGroupName: string | null;
  mutationPolicy: TableMutationPolicy;
  updatedAt: string;
};

export type TableAdminOverviewPage = {
  items: TableAdminOverviewItem[];
  page: number;
  perPage: number;
  total: number;
};

type Row = {
  id: string;
  name: string;
  kind: "stored" | "federated";
  field_count: number;
  indexed_field_count: number;
  unique_field_count: number;
  history_status: "activating" | "active" | null;
  finalization_mode: "direct" | "four_eyes" | null;
  approver_group_id: string | null;
  approver_group_name: string | null;
  mutation_policy: unknown;
  updated_at: Date | string;
  total: number;
};

export const list = async (baseId: string, filters: TableAdminOverviewFilters = {}): Promise<TableAdminOverviewPage> => {
  const q = filters.q?.trim() ?? "";
  const search = `%${q.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
  const kind = filters.kind ?? "all";
  const history = filters.history ?? "all";
  const finalization = filters.finalization ?? "all";
  const page = Math.max(filters.page ?? 1, 1);
  const perPage = Math.min(Math.max(filters.perPage ?? 25, 1), 100);
  const offset = (page - 1) * perPage;

  const rows = await sql<Row[]>`
    WITH field_counts AS (
      SELECT field.table_id,
             COUNT(*)::int AS field_count,
             COUNT(*) FILTER (WHERE field.indexed)::int AS indexed_field_count,
             COUNT(*) FILTER (WHERE field.unique_constraint)::int AS unique_field_count
      FROM grids.fields field
      JOIN grids.tables counted_table ON counted_table.id = field.table_id
      WHERE counted_table.base_id = ${baseId}::uuid
        AND counted_table.deleted_at IS NULL
        AND field.deleted_at IS NULL
      GROUP BY field.table_id
    )
    SELECT table_ref.id::text,
           table_ref.name,
           table_ref.kind,
           COALESCE(field_counts.field_count, 0)::int AS field_count,
           COALESCE(field_counts.indexed_field_count, 0)::int AS indexed_field_count,
           COALESCE(field_counts.unique_field_count, 0)::int AS unique_field_count,
           history.status AS history_status,
           finalization.mode AS finalization_mode,
           finalization.approver_group_id::text,
           approver_group.name AS approver_group_name,
           table_ref.mutation_policy,
           table_ref.updated_at,
           COUNT(*) OVER()::int AS total
    FROM grids.tables table_ref
    JOIN grids.bases base_ref ON base_ref.id = table_ref.base_id AND base_ref.deleted_at IS NULL
    LEFT JOIN field_counts ON field_counts.table_id = table_ref.id
    LEFT JOIN grids.durable_history_activations history ON history.table_id = table_ref.id
    LEFT JOIN grids.table_finalization_activations finalization ON finalization.table_id = table_ref.id
    LEFT JOIN auth.groups approver_group ON approver_group.id = finalization.approver_group_id
    WHERE table_ref.base_id = ${baseId}::uuid
      AND table_ref.deleted_at IS NULL
      AND (${q} = '' OR table_ref.name ILIKE ${search} ESCAPE '\\' OR table_ref.short_id ILIKE ${search} ESCAPE '\\')
      AND (${kind} = 'all' OR (${kind} = 'stored' AND table_ref.kind = 'stored') OR (${kind} = 'combined' AND table_ref.kind = 'federated'))
      AND (${history} = 'all'
        OR (${history} = 'off' AND history.table_id IS NULL)
        OR (${history} = 'preparing' AND history.status = 'activating')
        OR (${history} = 'active' AND history.status = 'active'))
      AND (${finalization} = 'all'
        OR (${finalization} = 'off' AND finalization.table_id IS NULL)
        OR (${finalization} = 'direct' AND finalization.mode = 'direct')
        OR (${finalization} = 'fourEyes' AND finalization.mode = 'four_eyes'))
    ORDER BY lower(table_ref.name), table_ref.id
    LIMIT ${perPage}
    OFFSET ${offset}
  `;

  return {
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind === "federated" ? "combined" : "stored",
      fieldCount: Number(row.field_count),
      indexedFieldCount: Number(row.indexed_field_count),
      uniqueFieldCount: Number(row.unique_field_count),
      durableHistory: row.history_status === "active" ? "active" : row.history_status === "activating" ? "preparing" : "off",
      finalizationMode: row.finalization_mode === "four_eyes" ? "fourEyes" : row.finalization_mode === "direct" ? "direct" : "off",
      approverGroupId: row.approver_group_id,
      approverGroupName: row.approver_group_name,
      mutationPolicy: TableMutationPolicySchema.parse(row.mutation_policy),
      updatedAt: new Date(row.updated_at).toISOString(),
    })),
    page,
    perPage,
    total: Number(rows[0]?.total ?? 0),
  };
};
