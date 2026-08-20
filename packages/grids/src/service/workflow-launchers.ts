import { err, fail, ok, type Result } from "@k2b/stdlib";
import type { WorkflowDiagnostic, WorkflowIrInput } from "@valentinkolb/cloud/workflows";
import { sql } from "bun";
import type {
  CreateGridsWorkflowLauncherInput,
  GridsWorkflow,
  GridsWorkflowLauncher,
  GridsWorkflowLauncherConfig,
  UpdateGridsWorkflowLauncherInput,
} from "../workflows/contracts";
import {
  correctionDraftIntent,
  correctionDraftPlanIntent,
  GridsWorkflowLauncherConfigSchema,
  isCanonicalCloseSelectionPlan,
  scannerLauncherInputSources,
} from "../workflows/contracts";
import { logAudit, type SqlClient } from "./audit";
import { parseJsonbRow } from "./jsonb";
import { insertWithShortId } from "./short-id";
import { workflowInputShapeError } from "./workflow-values";

type DbRow = Record<string, unknown>;

const selectColumns = sql`
  id, short_id, base_id, workflow_id, name, kind, config, enabled, validated_revision,
  diagnostics, deleted_at, created_at, updated_at
`;

const mapLauncher = (row: DbRow): GridsWorkflowLauncher => {
  const config = GridsWorkflowLauncherConfigSchema.safeParse(parseJsonbRow(row.config, null));
  if (!config.success) throw new Error("Stored workflow launcher config is invalid.");
  return {
    id: row.id as string,
    shortId: row.short_id as string,
    baseId: row.base_id as string,
    workflowId: row.workflow_id as string,
    name: row.name as string,
    config: config.data,
    enabled: Boolean(row.enabled),
    validatedRevision: Number(row.validated_revision),
    diagnostics: parseJsonbRow<WorkflowDiagnostic[]>(row.diagnostics, []),
    deletedAt: row.deleted_at ? (row.deleted_at as Date).toISOString() : null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
};

const inputByName = (workflow: GridsWorkflow, name: string): WorkflowIrInput | null =>
  workflow.plan.inputs.find((input) => input.name === name) ?? null;

export const validateLauncherConfig = (workflow: GridsWorkflow, config: GridsWorkflowLauncherConfig): WorkflowDiagnostic[] => {
  const diagnostics: WorkflowDiagnostic[] = [];
  const add = (code: string, message: string, path: Array<string | number>): void => {
    diagnostics.push({ code, message, severity: "error", path });
  };
  if (config.kind === "bulk") {
    const input = inputByName(workflow, config.input);
    const expected = "recordList";
    if (!input) add("launcher.input.unknown", `Unknown workflow input "${config.input}"`, ["config", "input"]);
    else if (input.type !== expected) {
      add("launcher.input.type", `${config.kind} requires a ${expected} input`, ["config", "input"]);
    }
    if (!("profile" in config)) {
      for (const candidate of workflow.plan.inputs) {
        if (candidate.name === config.input) continue;
        const message = workflowInputShapeError(candidate, undefined);
        if (message) {
          add("launcher.input.unsupplied", `${config.kind} run option cannot supply required workflow input "${candidate.name}"`, [
            "config",
            "input",
          ]);
        }
      }
    } else if (config.profile === "closeSelection" && !isCanonicalCloseSelectionPlan(workflow.plan, config.input)) {
      add("launcher.profile.plan", "Close selection requires its canonical exact-selection workflow plan", ["config", "profile"]);
    }
  }
  if (config.kind === "record") {
    const input = inputByName(workflow, config.input);
    if (!input) add("launcher.input.unknown", `Unknown workflow input "${config.input}"`, ["config", "input"]);
    else if (input.type !== "record") add("launcher.input.type", "record actions require a record input", ["config", "input"]);
    if (config.profile === "correctionDraft") {
      const planIntent = correctionDraftPlanIntent(workflow.plan, config.input);
      if (!planIntent) {
        add("launcher.profile.plan", "The linked-Draft Record action requires its canonical finalized-Record workflow plan", [
          "config",
          "profile",
        ]);
      } else if (correctionDraftIntent(config) !== planIntent) {
        add("launcher.profile.intent", "The run option action must match the linked-Draft workflow action", ["config", "intent"]);
      }
    }
  }
  if (config.kind === "scanner") {
    const sources = scannerLauncherInputSources(config);
    const sourceEntries = Object.entries(sources);
    const sourcePath = (name: string): Array<string | number> =>
      "inputSources" in config ? ["config", "inputSources", name] : ["config", "input"];
    const scanEntries = sourceEntries.filter(([, source]) => source.kind === "scan");
    if (scanEntries.length !== 1) {
      add("launcher.scan.count", "Scanner launchers require exactly one scan input source", ["config", "inputSources"]);
    }
    for (const [name, source] of sourceEntries) {
      const input = inputByName(workflow, name);
      if (!input) {
        add("launcher.input.unknown", `Unknown workflow input "${name}"`, sourcePath(name));
        continue;
      }
      if (source.kind === "scan") {
        const expected = source.value === "record" ? "record" : "text";
        if (input.type !== expected) {
          add("launcher.input.type", `Scanned ${source.value} requires a ${expected} input`, sourcePath(name));
        }
      }
      if (
        (source.kind === "session" || source.kind === "afterScan") &&
        !["record", "recordList", "text", "number", "boolean", "date", "dateTime", "select"].includes(input.type)
      ) {
        add("launcher.input.type", `Scanner prompts do not support workflow input type "${input.type}"`, sourcePath(name));
      }
      if (source.kind === "fixed") {
        const message = workflowInputShapeError(input, source.value);
        if (message) add("launcher.input.invalid", `Workflow input "${name}" ${message}`, sourcePath(name));
      }
      if (source.kind === "scan" && source.value === "record" && source.resolve.by === "field" && !source.resolve.field) {
        add("launcher.field.required", "Field resolution requires a field", [...sourcePath(name), "resolve", "field"]);
      }
    }
    for (const input of workflow.plan.inputs) {
      if (Object.hasOwn(sources, input.name)) continue;
      if (workflowInputShapeError(input, undefined)) {
        add("launcher.input.unsupplied", `scanner launcher cannot supply required workflow input "${input.name}"`, [
          "config",
          "inputSources",
          input.name,
        ]);
      }
    }
  }
  if (config.kind === "customApp") {
    for (const name of Object.keys(config.inputBindings ?? {})) {
      if (!inputByName(workflow, name))
        add("launcher.input.unknown", `Unknown workflow input "${name}"`, ["config", "inputBindings", name]);
    }
    if (config.inputMode === "prompt" && Object.keys(config.inputBindings ?? {}).length > 0) {
      add("launcher.input.mode", "Prompt Grids App launchers do not accept fixed input bindings", ["config", "inputBindings"]);
    }
    if (config.inputMode === "fixed") {
      for (const input of workflow.plan.inputs) {
        const message = workflowInputShapeError(input, config.inputBindings?.[input.name]);
        if (message) add("launcher.input.invalid", `Workflow input "${input.name}" ${message}`, ["config", "inputBindings", input.name]);
      }
    }
  }
  return diagnostics;
};

export const getLauncher = async (id: string, client: SqlClient = sql): Promise<GridsWorkflowLauncher | null> => {
  const [row] = await client<DbRow[]>`
    SELECT ${selectColumns}
    FROM grids.workflow_launchers
    WHERE id = ${id}::uuid AND deleted_at IS NULL
  `;
  return row ? mapLauncher(row) : null;
};

export const listLaunchers = async (workflowId: string, enabledOnly = false): Promise<GridsWorkflowLauncher[]> => {
  const rows = await sql<DbRow[]>`
    SELECT ${selectColumns}
    FROM grids.workflow_launchers
    WHERE workflow_id = ${workflowId}::uuid
      AND deleted_at IS NULL
      AND (${enabledOnly} = FALSE OR enabled = TRUE)
    ORDER BY created_at, id
  `;
  return rows.map(mapLauncher);
};

export const listLaunchersForBase = async (baseId: string, enabledOnly = false): Promise<GridsWorkflowLauncher[]> => {
  const rows = await sql<DbRow[]>`
    SELECT ${selectColumns}
    FROM grids.workflow_launchers
    WHERE base_id = ${baseId}::uuid
      AND deleted_at IS NULL
      AND (${enabledOnly} = FALSE OR enabled = TRUE)
    ORDER BY created_at, id
  `;
  return rows.map(mapLauncher);
};

export const createLauncher = async (
  workflow: GridsWorkflow,
  input: CreateGridsWorkflowLauncherInput,
  actorId: string | null,
): Promise<Result<GridsWorkflowLauncher>> => {
  const diagnostics = validateLauncherConfig(workflow, input.config);
  if (diagnostics.length > 0) return fail(err.badInput(diagnostics.map((item) => item.message).join("; ")));
  const launcher = await sql.begin(async (tx) => {
    const row = await insertWithShortId(
      (shortId) =>
        tx.savepoint(async (sp) => {
          const [inserted] = await sp<DbRow[]>`
            INSERT INTO grids.workflow_launchers (
              short_id, base_id, workflow_id, name, kind, config, enabled, validated_revision, diagnostics
            ) VALUES (
              ${shortId}, ${workflow.baseId}::uuid, ${workflow.id}::uuid, ${input.name.trim()}, ${input.config.kind},
              ${input.config}::jsonb, ${input.enabled ?? true}, ${workflow.revision}, '[]'::jsonb
            )
            RETURNING ${selectColumns}
          `;
          if (!inserted) throw new Error("workflow run option insert failed");
          return inserted;
        }),
      "idx_grids_workflow_launchers_short_id",
    );
    const created = mapLauncher(row);
    await logAudit(
      {
        baseId: workflow.baseId,
        userId: actorId,
        action: "workflow.updated",
        diff: { workflowLauncher: { old: null, new: { id: created.id, workflowId: workflow.id, kind: created.config.kind } } },
      },
      tx,
    );
    return created;
  });
  return ok(launcher);
};

export const updateLauncher = async (
  launcher: GridsWorkflowLauncher,
  workflow: GridsWorkflow,
  input: UpdateGridsWorkflowLauncherInput,
  actorId: string | null,
): Promise<Result<GridsWorkflowLauncher>> => {
  const config = input.config ?? launcher.config;
  const diagnostics = validateLauncherConfig(workflow, config);
  if (diagnostics.length > 0) return fail(err.badInput(diagnostics.map((item) => item.message).join("; ")));
  const [row] = await sql<DbRow[]>`
    UPDATE grids.workflow_launchers
    SET name = ${input.name?.trim() ?? launcher.name},
        kind = ${config.kind},
        config = ${config}::jsonb,
        enabled = ${input.enabled ?? launcher.enabled},
        validated_revision = ${workflow.revision},
        diagnostics = '[]'::jsonb,
        updated_at = now()
    WHERE id = ${launcher.id}::uuid AND deleted_at IS NULL
    RETURNING ${selectColumns}
  `;
  if (!row) return fail(err.notFound("workflow launcher"));
  const updated = mapLauncher(row);
  await logAudit({
    baseId: workflow.baseId,
    userId: actorId,
    action: "workflow.updated",
    diff: { workflowLauncher: { old: { id: launcher.id }, new: { id: updated.id, kind: updated.config.kind } } },
  });
  return ok(updated);
};

export const removeLauncher = async (launcher: GridsWorkflowLauncher, actorId: string | null): Promise<void> => {
  await sql`
    UPDATE grids.workflow_launchers
    SET deleted_at = now(), enabled = FALSE, updated_at = now()
    WHERE id = ${launcher.id}::uuid AND deleted_at IS NULL
  `;
  await logAudit({
    baseId: launcher.baseId,
    userId: actorId,
    action: "workflow.updated",
    diff: { workflowLauncher: { old: { id: launcher.id, kind: launcher.config.kind }, new: null } },
  });
};
