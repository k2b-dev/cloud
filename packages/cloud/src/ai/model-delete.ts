import { sql } from "bun";
import { z } from "zod";
import { recursiveGroupIdsSubquery } from "../services/accounts/group-sql";
import { toPgTextArray } from "../services/postgres";
import type { WorkflowBoundPlan, WorkflowIrStep, WorkflowJsonValue } from "../workflows/contracts";
import { hashWorkflowSource } from "../workflows/language/canonical";
import { publishWorkflowVersion, type WorkflowActivationInput } from "../workflows/store/definitions";
import { aiModelAccess } from "./model-access";
import { AiConfigError, aiModelCatalog, assertAiRevision, lockAiModelCatalog, validateAiSlot } from "./model-catalog";
import type { AiDeleteModelInput, AiModel, AiModelSlot, AiProvider } from "./model-contracts";

export const validateAiReplacement = (source: AiProvider, target: AiProvider, original: AiModel, replacement: AiModel): void => {
  if (source.dataBoundary === "private" && target.dataBoundary !== "private")
    throw new AiConfigError("invalid_configuration", "A private model cannot be replaced with a hosted model.");
  if (
    !target.enabled ||
    !replacement.enabled ||
    original.kind !== replacement.kind ||
    original.capabilities.some((capability) => !replacement.capabilities.includes(capability))
  )
    throw new AiConfigError(
      "invalid_configuration",
      "The replacement must be enabled and support the original model's kind and capabilities.",
    );
};
const referencedAiModels = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(referencedAiModels);
  if (value !== null && typeof value === "object") {
    const parsed = z.record(z.string(), z.unknown()).parse(value);
    return Object.entries(parsed).flatMap(([key, entry]) =>
      key === "model"
        ? (() => {
            const model = z.object({ id: z.string() }).safeParse(entry);
            return model.success ? [model.data.id] : referencedAiModels(entry);
          })()
        : referencedAiModels(entry),
    );
  }
  return [];
};
const retargetJson = (value: WorkflowJsonValue, ids: string[], replacement: string): WorkflowJsonValue => {
  if (Array.isArray(value)) return value.map((entry) => retargetJson(entry, ids, replacement));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        key === "model" &&
        entry !== null &&
        !Array.isArray(entry) &&
        typeof entry === "object" &&
        typeof entry.id === "string" &&
        ids.includes(entry.id)
          ? { id: replacement }
          : retargetJson(entry, ids, replacement),
      ]),
    );
  return value;
};
const retargetSteps = (steps: WorkflowIrStep[], ids: string[], replacement: string): WorkflowIrStep[] =>
  steps.map((step) => {
    if (step.kind === "action")
      return {
        ...step,
        config: Object.fromEntries(
          Object.entries(step.config).map(([key, value]) => [
            key,
            key === "model" &&
            value !== null &&
            !Array.isArray(value) &&
            typeof value === "object" &&
            typeof value.id === "string" &&
            ids.includes(value.id)
              ? { id: replacement }
              : value,
          ]),
        ),
      };
    if (step.kind === "if")
      return { ...step, then: retargetSteps(step.then, ids, replacement), else: retargetSteps(step.else, ids, replacement) };
    if (step.kind === "switch")
      return {
        ...step,
        cases: step.cases.map((entry) => ({ ...entry, steps: retargetSteps(entry.steps, ids, replacement) })),
        default: retargetSteps(step.default, ids, replacement),
      };
    return { ...step, steps: retargetSteps(step.steps, ids, replacement) };
  });
export const deleteAiCatalogEntry = async (
  kind: "provider" | "model" | "variant",
  id: string,
  input: AiDeleteModelInput,
  actorId: string,
) =>
  sql.begin(async (db) => {
    // One catalog lock orders deletion with assignment and catalog writes.
    await lockAiModelCatalog(db);
    const current =
      kind === "provider"
        ? await aiModelCatalog.providerDetail(id, db)
        : kind === "model"
          ? await aiModelCatalog.modelDetail(id, db)
          : await aiModelCatalog.variant(id, db, true);
    await assertAiRevision(current, input.revision, db);
    const allModels = await aiModelCatalog.models(db),
      allVariants = await aiModelCatalog.variants(db),
      providers = await aiModelCatalog.providers(db);
    const affectedModels =
      kind === "provider"
        ? allModels.filter((model) => model.providerId === id)
        : allModels.filter((model) => model.id === (kind === "model" ? id : allVariants.find((v) => v.id === id)?.modelId));
    if (kind === "variant" && allVariants.find((v) => v.id === id)?.slug === "standard")
      throw new AiConfigError("invalid_configuration", "The standard variant can only be deleted with its model.");
    const affected = allVariants.filter((v) => (kind === "variant" ? v.id === id : affectedModels.some((m) => m.id === v.modelId)));
    const ids = affected.map((v) => v.id),
      pgIds = toPgTextArray(ids);
    const target = (variantId: string, sourceModel: AiModel, slot?: AiModelSlot) => {
      const variant = allVariants.find((v) => v.id === variantId && !ids.includes(v.id));
      const model = allModels.find((m) => m.id === variant?.modelId),
        provider = providers.find((p) => p.id === model?.providerId),
        source = providers.find((p) => p.id === sourceModel.providerId);
      if (!model || !provider || !source)
        throw new AiConfigError("invalid_configuration", "Choose a replacement outside the deleted selection.");
      validateAiReplacement(source, provider, sourceModel, model);
      if (slot) validateAiSlot(slot, model);
    };
    const assignments = (await aiModelCatalog.assignments(db)).filter((a) => a.variantId && ids.includes(a.variantId));
    for (const assignment of assignments) {
      if (!Object.hasOwn(input.replacements, assignment.slot))
        throw new AiConfigError("invalid_configuration", "Every affected assignment needs a replacement or an explicit empty choice.");
      const replacement = input.replacements[assignment.slot];
      const sourceModel = affectedModels.find((m) => m.id === affected.find((v) => v.id === assignment.variantId)?.modelId);
      if (replacement && sourceModel) target(replacement, sourceModel, assignment.slot);
    }
    if (input.retarget && !input.retargetTo) throw new AiConfigError("invalid_configuration", "Retargeting requires a replacement.");
    for (const assignment of assignments)
      await db`UPDATE ai.model_assignments SET variant_id=${input.replacements[assignment.slot] ?? null},revision=revision+1,updated_by=${actorId}::uuid,updated_at=clock_timestamp() WHERE slot=${assignment.slot}`;
    const projects = await db<
      { id: string; short_id: string; name: string; default_model: { id: string } }[]
    >`SELECT id,short_id,name,default_model FROM ai.projects WHERE default_model->>'id'=ANY(${pgIds}::text[]) FOR UPDATE`;
    const workflows = await db<
      {
        id: string;
        name: string;
        created_by_kind: string;
        created_by_id: string | null;
        source: string;
        plan: WorkflowBoundPlan;
        effect_budget: Record<string, number>;
      }[]
    >`SELECT w.id,w.name,w.created_by_kind,w.created_by_id,v.source,v.plan,v.effect_budget FROM workflows.workflow w JOIN workflows.version v ON v.id=w.active_version_id WHERE EXISTS(SELECT 1 FROM jsonb_path_query(v.plan,'$.**.model.id') ref WHERE ref #>> '{}' = ANY(${pgIds}::text[])) FOR UPDATE OF w`;
    if (input.retarget && input.retargetTo) {
      const references = [
        ...projects.map((project) => project.default_model.id),
        ...workflows.flatMap((workflow) => referencedAiModels(workflow.plan)),
      ];
      for (const model of affectedModels.filter((model) =>
        affected.some((variant) => variant.modelId === model.id && references.includes(variant.id)),
      ))
        target(input.retargetTo, model);
    }
    const scheduled = await db<
      { sponsor_user_id: string; name: string }[]
    >`SELECT task.sponsor_user_id,left(task.prompt,120) AS name FROM ai.chat_tasks task JOIN ai.conversations c ON c.id=task.conversation_id JOIN ai.projects p ON p.id=c.project_id WHERE p.default_model->>'id'=ANY(${pgIds}::text[])`;
    for (const task of scheduled)
      await db`INSERT INTO ai.model_change_notices(user_id,name,retargeted) VALUES(${task.sponsor_user_id}::uuid,${task.name},${input.retarget})`;
    for (const project of projects) {
      const owners = await db<
        { id: string }[]
      >`SELECT DISTINCT u.id FROM ai.project_access p JOIN auth.access a ON a.id=p.access_id JOIN auth.users u ON a.user_id=u.id OR a.authenticated_only OR a.group_id IN (${recursiveGroupIdsSubquery(db`u.id`)}) WHERE p.project_id=${project.id}::uuid AND a.permission='admin'`;
      for (const owner of owners)
        await db`INSERT INTO ai.model_change_notices(user_id,name,retargeted) VALUES(${owner.id}::uuid,${project.name},${input.retarget})`;
      if (input.retarget)
        await db`UPDATE ai.projects SET default_model=${JSON.stringify({ id: input.retargetTo })}::jsonb,revision=revision+1,updated_at=clock_timestamp() WHERE id=${project.id}::uuid`;
    }
    for (const workflow of workflows) {
      if (workflow.created_by_kind === "user" && workflow.created_by_id)
        await db`INSERT INTO ai.model_change_notices(user_id,name,retargeted) VALUES(${workflow.created_by_id}::uuid,${workflow.name},${input.retarget})`;
      if (!input.retarget || !input.retargetTo) continue;
      const activations = await db<
        (WorkflowActivationInput & { event_type: string; authorization_snapshot: WorkflowJsonValue })[]
      >`SELECT key,event_type,config,enabled,authorization_snapshot FROM workflows.activation WHERE workflow_id=${workflow.id}::uuid`;
      const parsed: WorkflowJsonValue = z.json().parse(Bun.YAML.parse(workflow.source));
      const source = Bun.YAML.stringify(retargetJson(parsed, ids, input.retargetTo));
      const plan: WorkflowBoundPlan = {
        ...workflow.plan,
        sourceHash: await hashWorkflowSource(source),
        steps: retargetSteps(workflow.plan.steps, ids, input.retargetTo),
        bindings: Object.fromEntries(
          Object.entries(workflow.plan.bindings).map(([key, value]) => [
            key,
            key === "model" &&
            value !== null &&
            !Array.isArray(value) &&
            typeof value === "object" &&
            typeof value.id === "string" &&
            ids.includes(value.id)
              ? { id: input.retargetTo! }
              : retargetJson(value, ids, input.retargetTo!),
          ]),
        ),
      };
      await publishWorkflowVersion(
        {
          workflowId: workflow.id,
          source,
          plan,
          effectBudget: workflow.effect_budget,
          author: { kind: "user", id: actorId },
          activations: activations.map((a) => ({ ...a, eventType: a.event_type })),
        },
        { db },
      );
      for (const activation of activations)
        await db`UPDATE workflows.activation SET authorization_snapshot=${JSON.stringify(activation.authorization_snapshot)}::jsonb WHERE workflow_id=${workflow.id}::uuid AND key=${activation.key}`;
    }
    if (kind === "variant") await db`DELETE FROM ai.model_variants WHERE id=${id}`;
    else if (kind === "model") await db`DELETE FROM ai.models WHERE id=${id}`;
    else await db`DELETE FROM ai.providers WHERE id=${id}`;
    if (kind !== "variant") {
      const modelIds = affectedModels.map((m) => m.id);
      const [config] = await db<{ rules: WorkflowJsonValue[] }[]>`SELECT rules FROM ai.cost_config WHERE singleton FOR UPDATE`;
      const rules = (config?.rules ?? []).filter(
        (rule) =>
          rule === null ||
          Array.isArray(rule) ||
          typeof rule !== "object" ||
          typeof rule.scope !== "string" ||
          !modelIds.includes(rule.scope),
      );
      await db`UPDATE ai.cost_config SET rules=${JSON.stringify(rules)}::jsonb,revision=revision+1 WHERE singleton`;
      await aiModelAccess.syncModels(
        (await aiModelCatalog.models(db)).map((model) => model.id),
        [],
        db,
      );
    }
    return { deleted: true };
  });
