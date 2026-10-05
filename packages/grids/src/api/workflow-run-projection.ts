import { z } from "zod";
import { publicDiagnosticValue } from "../service/public-diagnostics";
import { type PublicResourceType, projectPublicIds } from "../service/public-resources";
import { projectWorkflowCaptureSteps, WorkflowDocumentDataReferenceSchema } from "../service/workflow-query-store";
import type { GridsWorkflowRun, GridsWorkflowStepRun } from "../workflows/contracts";
import { PublicGridsWorkflowRunSchema, PublicGridsWorkflowStepRunListSchema } from "./workflow-public-contracts";

/*
 * Public IDs for workflow runs, their steps, and their payloads. Kept apart from
 * ./workflow-api-shared, so the workflow runtime can project the run updates it
 * publishes without loading the API layer.
 */

export type PublicIdLoader = typeof projectPublicIds;
export type PublicIdMaps = Partial<Record<PublicResourceType, Map<string, string>>>;

export const requiredPublicId = (maps: PublicIdMaps, type: PublicResourceType, internalId: string): string => {
  const publicId = maps[type]?.get(internalId);
  if (!publicId) throw new Error(`Missing public id for ${type}`);
  return publicId;
};

export const optionalPublicId = (maps: PublicIdMaps, type: PublicResourceType, internalId: string | null): string | null =>
  internalId === null ? null : requiredPublicId(maps, type, internalId);

export const loadPublicIdMaps = async (
  references: Partial<Record<PublicResourceType, readonly string[]>>,
  load: PublicIdLoader = projectPublicIds,
): Promise<PublicIdMaps> =>
  Object.fromEntries(
    await Promise.all(Object.entries(references).map(async ([type, ids]) => [type, await load(type as PublicResourceType, ids)] as const)),
  );

export const toPublicWorkflowPayloads = async (
  payloads: readonly unknown[],
  load: PublicIdLoader = projectPublicIds,
  loadCaptureSteps: typeof projectWorkflowCaptureSteps = projectWorkflowCaptureSteps,
): Promise<unknown[]> => {
  const captureIds = new Set<string>();
  const references: Partial<Record<PublicResourceType, string[]>> = {};
  // Project typed Grids references, never arbitrary strings returned by HTTP or
  // entered as text inputs. One lookup per referenced resource type, not per row.
  const identityFields = (value: Record<string, unknown>): Record<string, PublicResourceType> => {
    if (value.kind === "record") return { tableId: "table", recordId: "record" };
    if (value.kind === "documentLink") return { id: "documentLink", documentId: "document" };
    if (value.kind === "document" || (typeof value.shortId === "string" && "primaryArtifactKey" in value))
      return { id: "document", baseId: "base", tableId: "table", recordId: "record", templateId: "documentTemplate" };
    if (typeof value.templateId === "string" && typeof value.subject === "string" && Array.isArray(value.recipients))
      return { templateId: "emailTemplate" };
    return {};
  };
  const collect = (value: unknown): void => {
    const reference = WorkflowDocumentDataReferenceSchema.safeParse(value);
    if (reference.success) {
      captureIds.add(reference.data.id);
    } else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") {
      const object = z.record(z.string(), z.unknown()).parse(value);
      for (const [key, type] of Object.entries(identityFields(object))) {
        const id = object[key];
        if (typeof id === "string" && z.uuid().safeParse(id).success) {
          references[type] ??= [];
          references[type].push(id);
        }
      }
      Object.values(object).forEach(collect);
    }
  };
  payloads.forEach(collect);
  const [steps, maps] = await Promise.all([
    captureIds.size ? loadCaptureSteps([...captureIds]) : new Map<string, string>(),
    loadPublicIdMaps(Object.fromEntries(Object.entries(references).map(([type, ids]) => [type, [...new Set(ids)]])), load),
  ]);
  const project = (value: unknown): unknown => {
    const reference = WorkflowDocumentDataReferenceSchema.safeParse(value);
    if (reference.success) {
      const { id, ...rest } = reference.data;
      const stepKey = steps.get(id);
      if (!stepKey) throw new Error("Missing workflow capture step");
      return { ...rest, stepKey };
    }
    if (Array.isArray(value)) return value.map(project);
    if (!value || typeof value !== "object") return value;
    const object = z.record(z.string(), z.unknown()).parse(value);
    const identities = identityFields(object);
    return Object.fromEntries(
      Object.entries(object).map(([key, item]) => {
        const type = identities[key];
        return [
          key,
          type && typeof item === "string" && z.uuid().safeParse(item).success ? requiredPublicId(maps, type, item) : project(item),
        ];
      }),
    );
  };
  return payloads.map(project);
};

export const toPublicWorkflowError = (error: GridsWorkflowRun["error"]) =>
  PublicGridsWorkflowRunSchema.shape.error.parse(publicDiagnosticValue(error));

export const toPublicWorkflowSteps = async (
  page: { items: GridsWorkflowStepRun[]; truncated: boolean },
  runPublicId: string,
  load: PublicIdLoader = projectPublicIds,
  loadCaptureSteps: typeof projectWorkflowCaptureSteps = projectWorkflowCaptureSteps,
) => {
  const outcomes = await toPublicWorkflowPayloads(
    page.items.map((step) => step.outcome),
    load,
    loadCaptureSteps,
  );
  return PublicGridsWorkflowStepRunListSchema.parse({
    items: page.items.map((step, index) => ({
      runId: runPublicId,
      key: step.key,
      sourcePath: step.sourcePath,
      iterationPath: step.iterationPath,
      kind: step.kind,
      action: step.action,
      status: step.status,
      outcome: z
        .json()
        .nullable()
        .parse(step.status === "failed" ? publicDiagnosticValue(outcomes[index]) : outcomes[index]),
      ...(step.documentConfirmation ? { documentConfirmation: step.documentConfirmation } : {}),
      executionGeneration: step.executionGeneration,
      startedAt: step.startedAt,
      finishedAt: step.finishedAt,
    })),
    truncated: page.truncated,
  });
};
