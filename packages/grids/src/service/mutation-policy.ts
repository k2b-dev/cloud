import { err, fail, ok, type Result } from "@k2b/stdlib";
import type { WorkflowBoundPlan, WorkflowIrStep, WorkflowJsonValue } from "@valentinkolb/cloud/workflows";
import { sql } from "bun";
import type { MutationSource, TableMutationPolicy } from "../contracts";
import { MutationSourceSchema, TableMutationPolicySchema } from "../contracts";
import { logAudit, type SqlClient } from "./audit";
import { emitMetadataEvent } from "./metadata-events";

export type MutationOrigin = MutationSource;

const sourceLabels: Record<MutationOrigin, string> = {
  direct: "direct editing and the record API",
  form: "forms",
  workflow: "workflows and actions",
};

const parsePolicy = (value: unknown): Result<TableMutationPolicy> => {
  const parsed = TableMutationPolicySchema.safeParse(value);
  return parsed.success ? ok(parsed.data) : fail(err.forbidden("This table's mutation policy is invalid; an admin must repair it."));
};

export const assertMutationAllowed = async (client: SqlClient, tableId: string, origin: MutationOrigin): Promise<Result<void>> => {
  const trustedOrigin = MutationSourceSchema.safeParse(origin);
  if (!trustedOrigin.success) return fail(err.forbidden("A trusted mutation source is required."));
  const [row] = await client<Array<{ kind: string; mutation_policy: unknown }>>`
    SELECT kind, mutation_policy
    FROM grids.tables
    WHERE id = ${tableId}::uuid AND deleted_at IS NULL
    FOR SHARE
  `;
  if (!row || row.kind !== "stored") return fail(err.notFound("Table"));
  const policy = parsePolicy(row.mutation_policy);
  if (!policy.ok) return policy;
  if (policy.data.mode === "all" || policy.data.sources.includes(trustedOrigin.data)) return ok();
  return fail(err.forbidden(`This table does not allow changes from ${sourceLabels[trustedOrigin.data]}.`));
};

export type MutationPolicyImpactItem = {
  kind: "form" | "workflow" | "action";
  id: string;
  name: string;
};

export type MutationPolicyImpact = {
  items: MutationPolicyImpactItem[];
  total: number;
  limit: number;
  truncated: boolean;
  complete: boolean;
};

const WORKFLOW_SCAN_LIMIT = 500;

const workflowPathKey = (path: Array<string | number>): string => path.map(String).join(".");

const recordTableForReference = (
  reference: WorkflowJsonValue | undefined,
  scope: ReadonlyMap<string, string>,
  bindings: WorkflowBoundPlan["bindings"],
  bindingPath: Array<string | number>,
): string | null => {
  if (typeof reference !== "string") return null;
  const relationTarget = bindings[`${workflowPathKey(bindingPath)}.$relationTarget`];
  if (typeof relationTarget === "string") return relationTarget;
  const segments = reference.split(".");
  return scope.get(segments[0] === "inputs" ? segments.slice(0, 2).join(".") : segments[0]!) ?? null;
};

const mutationTargets = (
  steps: WorkflowIrStep[],
  bindings: WorkflowBoundPlan["bindings"],
  inheritedScope: ReadonlyMap<string, string>,
): Set<string> => {
  const targets = new Set<string>();
  const scope = new Map(inheritedScope);
  for (const step of steps) {
    if (step.kind === "if") {
      for (const target of mutationTargets(step.then, bindings, scope)) targets.add(target);
      for (const target of mutationTargets(step.else, bindings, scope)) targets.add(target);
      continue;
    }
    if (step.kind === "switch") {
      for (const branch of step.cases) {
        for (const target of mutationTargets(branch.steps, bindings, scope)) targets.add(target);
      }
      for (const target of mutationTargets(step.default, bindings, scope)) targets.add(target);
      continue;
    }
    if (step.kind === "forEach") {
      const loopScope = new Map(scope);
      const relationTarget = bindings[`${workflowPathKey([...step.sourcePath, "forEach"])}.$relationTarget`];
      const referencedTable = recordTableForReference(step.reference, scope, bindings, [...step.sourcePath, "forEach"]);
      const itemTable = typeof relationTarget === "string" ? relationTarget : referencedTable;
      if (itemTable) loopScope.set(step.alias, itemTable);
      for (const target of mutationTargets(step.steps, bindings, loopScope)) targets.add(target);
      continue;
    }

    const actionPath = [...step.sourcePath, step.action];
    let outputTable: string | null = null;
    if (step.action === "createRecord") {
      const boundTable = bindings[`${workflowPathKey(actionPath)}.table`];
      if (typeof boundTable === "string") {
        targets.add(boundTable);
        outputTable = boundTable;
      }
    } else if (step.action === "updateRecord" || step.action === "finalizeRecord" || step.action === "closeRecord") {
      const target = recordTableForReference(step.config.record, scope, bindings, [...actionPath, "record"]);
      if (target) {
        targets.add(target);
        outputTable = target;
      }
    } else if (step.action === "atomicRecords" && Array.isArray(step.config.changes)) {
      step.config.changes.forEach((rawChange, index) => {
        if (!rawChange || typeof rawChange !== "object" || Array.isArray(rawChange)) return;
        const change = rawChange as Record<string, WorkflowJsonValue>;
        const changePath = [...actionPath, "changes", index];
        if (change.createRecord && typeof change.createRecord === "object" && !Array.isArray(change.createRecord)) {
          const boundTable = bindings[`${workflowPathKey([...changePath, "createRecord"])}.table`];
          if (typeof boundTable === "string") targets.add(boundTable);
        }
        if (change.updateRecord && typeof change.updateRecord === "object" && !Array.isArray(change.updateRecord)) {
          const target = recordTableForReference(change.updateRecord.record, scope, bindings, [...changePath, "updateRecord", "record"]);
          if (target) targets.add(target);
        }
      });
    }
    const saveAs = step.config.saveAs;
    if (outputTable && typeof saveAs === "string") scope.set(saveAs, outputTable);
  }
  return targets;
};

export const workflowMutatesTable = (plan: unknown, tableId: string): boolean => {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return false;
  const candidate = plan as Partial<WorkflowBoundPlan>;
  if (!Array.isArray(candidate.steps) || !candidate.bindings || typeof candidate.bindings !== "object") return false;
  const inputScope = new Map<string, string>();
  for (const input of Array.isArray(candidate.inputs) ? candidate.inputs : []) {
    const table = candidate.bindings[`inputs.${input.name}.table`];
    if (typeof table === "string") inputScope.set(`inputs.${input.name}`, table);
  }
  return mutationTargets(candidate.steps, candidate.bindings, inputScope).has(tableId);
};

export const getImpact = async (
  tableId: string,
  policy: TableMutationPolicy,
  options: { limit?: number; client?: SqlClient } = {},
): Promise<Result<MutationPolicyImpact>> => {
  const client = options.client ?? sql;
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const parsedPolicy = TableMutationPolicySchema.safeParse(policy);
  if (!parsedPolicy.success) return fail(err.badInput(parsedPolicy.error.issues[0]?.message ?? "Invalid mutation policy"));
  const [table] = await client<Array<{ base_id: string; kind: string; mutation_policy: unknown }>>`
    SELECT base_id::text, kind, mutation_policy FROM grids.tables
    WHERE id = ${tableId}::uuid AND deleted_at IS NULL
  `;
  if (!table || table.kind !== "stored") return fail(err.notFound("Table"));
  const currentPolicy = parsePolicy(table.mutation_policy);
  if (!currentPolicy.ok) return fail(currentPolicy.error);
  const currentAllowed =
    currentPolicy.data.mode === "all" ? new Set<MutationSource>(["direct", "form", "workflow"]) : new Set(currentPolicy.data.sources);
  const nextAllowed =
    parsedPolicy.data.mode === "all" ? new Set<MutationSource>(["direct", "form", "workflow"]) : new Set(parsedPolicy.data.sources);
  const removed = new Set([...currentAllowed].filter((source) => !nextAllowed.has(source)));
  const items: MutationPolicyImpactItem[] = [];
  let total = 0;
  let complete = true;
  const addItem = (item: MutationPolicyImpactItem) => {
    total += 1;
    if (items.length < limit) items.push(item);
  };

  if (removed.has("form")) {
    const forms = await client<Array<{ short_id: string; name: string; total_count: number }>>`
      SELECT form.short_id, form.name, count(*) OVER ()::int AS total_count
      FROM grids.forms form
      WHERE form.deleted_at IS NULL AND form.is_active = TRUE
        AND (
          form.table_id = ${tableId}::uuid
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              CASE
                WHEN jsonb_typeof(form.config -> 'fields') = 'array' THEN form.config -> 'fields'
                ELSE '[]'::jsonb
              END
            ) entry
            JOIN grids.fields relation_field
              ON relation_field.id::text = entry ->> 'fieldId'
             AND relation_field.table_id = form.table_id
             AND relation_field.type = 'relation'
             AND relation_field.deleted_at IS NULL
             AND relation_field.config ->> 'targetTableId' = ${tableId}
            WHERE entry -> 'inlineCreate' ->> 'enabled' = 'true'
          )
        )
      ORDER BY form.position, form.created_at, form.id
      LIMIT ${limit}
    `;
    total += forms[0]?.total_count ?? 0;
    for (const form of forms) items.push({ kind: "form", id: form.short_id, name: form.name });
  }

  if (removed.has("workflow")) {
    const workflows = await client<Array<{ id: string; short_id: string; name: string; revision: number; plan: unknown }>>`
      SELECT profile.id::text, profile.short_id, definition.name, version.revision, version.plan
      FROM grids.workflow_profile profile
      JOIN workflows.workflow definition ON definition.id = profile.id
      JOIN LATERAL (
        SELECT revision, plan FROM workflows.version
        WHERE workflow_id = profile.id ORDER BY revision DESC LIMIT 1
      ) version ON TRUE
      WHERE profile.base_id = ${table.base_id}::uuid
        AND profile.deleted_at IS NULL AND profile.enabled = TRUE
        AND version.plan::text LIKE ${`%${tableId}%`}
      ORDER BY profile.position, profile.created_at, profile.id
      LIMIT ${WORKFLOW_SCAN_LIMIT + 1}
    `;
    if (workflows.length > WORKFLOW_SCAN_LIMIT) complete = false;
    const impactedWorkflows = workflows.slice(0, WORKFLOW_SCAN_LIMIT).filter((workflow) => workflowMutatesTable(workflow.plan, tableId));
    for (const workflow of impactedWorkflows) {
      addItem({ kind: "workflow", id: workflow.short_id, name: workflow.name });
    }
    if (impactedWorkflows.length > 0) {
      const workflowIds = impactedWorkflows.map((workflow) => workflow.id);
      const actionLimit = Math.max(limit - items.length, 1);
      const actions = await client<Array<{ short_id: string; name: string; total_count: number }>>`
        SELECT launcher.short_id, launcher.name, count(*) OVER ()::int AS total_count
        FROM grids.workflow_launchers launcher
        WHERE launcher.workflow_id = ANY(${client.array(workflowIds, "UUID")}::uuid[])
          AND launcher.deleted_at IS NULL AND launcher.enabled = TRUE
          AND launcher.validated_revision = (
            SELECT max(version.revision) FROM workflows.version version WHERE version.workflow_id = launcher.workflow_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(
              CASE
                WHEN jsonb_typeof(launcher.diagnostics) = 'array' THEN launcher.diagnostics
                ELSE '[]'::jsonb
              END
            ) diagnostic
            WHERE diagnostic ->> 'severity' = 'error'
          )
        ORDER BY launcher.created_at, launcher.id
        LIMIT ${actionLimit}
      `;
      total += actions[0]?.total_count ?? 0;
      for (const action of actions.slice(0, Math.max(limit - items.length, 0))) {
        items.push({ kind: "action", id: action.short_id, name: action.name });
      }
    }
  }

  return ok({ items, total, limit, truncated: !complete || total > items.length, complete });
};

export const update = async (
  tableId: string,
  policy: TableMutationPolicy,
  actorId: string | null,
): Promise<Result<TableMutationPolicy>> => {
  const result = await sql.begin(async (tx): Promise<Result<{ baseId: string; changed: boolean; policy: TableMutationPolicy }>> => {
    const parsed = TableMutationPolicySchema.safeParse(policy);
    if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid mutation policy"));
    const [row] = await tx<Array<{ base_id: string; kind: string; mutation_policy: unknown }>>`
        SELECT base_id::text, kind, mutation_policy
        FROM grids.tables
        WHERE id = ${tableId}::uuid AND deleted_at IS NULL
        FOR UPDATE
      `;
    if (!row || row.kind !== "stored") return fail(err.notFound("Table"));
    const previous = parsePolicy(row.mutation_policy);
    if (!previous.ok) return previous;
    if (JSON.stringify(previous.data) === JSON.stringify(parsed.data)) {
      return ok({ baseId: row.base_id, changed: false, policy: previous.data });
    }
    await tx`
        UPDATE grids.tables
        SET mutation_policy = ${parsed.data}::jsonb, updated_at = now()
        WHERE id = ${tableId}::uuid
      `;
    await logAudit(
      {
        baseId: row.base_id,
        tableId,
        userId: actorId,
        action: "mutation_policy.updated",
        diff: { mutationPolicy: { old: previous.data, new: parsed.data } },
      },
      tx,
    );
    return ok({ baseId: row.base_id, changed: true, policy: parsed.data });
  });
  if (!result.ok) return result;
  if (result.data.changed) {
    await emitMetadataEvent({
      type: "table.updated",
      baseId: result.data.baseId,
      resource: { kind: "table", id: tableId, tableId },
      actorId,
    });
  }
  return ok(result.data.policy);
};
