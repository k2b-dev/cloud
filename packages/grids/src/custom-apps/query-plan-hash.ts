import { createHash } from "node:crypto";
import type { DslQueryContextInput, DslQueryContextValues } from "../query-dsl/parameters";
import { dslQueryReferencedFieldIds } from "../query-dsl/plan-dependencies";
import type { DslResolvedSqlQueryPlan } from "../query-dsl/resolver";
import type { Field } from "../service/types";
import { stableCustomAppValue } from "./stable-value";

const CANONICAL_UUID = "00000000-0000-4000-8000-000000000000";
const CANONICAL_RECORD_ID = "REC001";

/** Resolve published and runtime sources against the same non-user input. */
export const canonicalCustomAppQueryContext = (context: DslQueryContextInput): DslQueryContextValues => ({
  "auth.id": CANONICAL_UUID,
  "auth.name": "Reader",
  "auth.username": "reader",
  "auth.email": "reader@example.test",
  "auth.subjects": [CANONICAL_UUID],
  "page.id": "page",
  "page.title": "Page",
  "page.url": "/custom-app/page",
  "app.id": "APP001",
  "app.name": "App",
  "base.id": "BASE01",
  "base.name": "Base",
  "time.now": "2000-01-01T00:00:00.000Z",
  "time.today": "2000-01-01",
  "time.timeZone": "UTC",
  ...Object.fromEntries(
    Object.keys(context)
      .filter((key) => key.startsWith("params."))
      .map((key) => [key, CANONICAL_RECORD_ID]),
  ),
});

const fieldMap = (fieldsByTableId: Record<string, Field[]>): Map<string, Field> =>
  new Map(
    Object.values(fieldsByTableId)
      .flat()
      .map((field) => [field.id, field]),
  );

const relationTargetId = (field: Field): string | null => {
  if (field.type !== "relation") return null;
  const targetTableId = (field.config as { targetTableId?: unknown }).targetTableId;
  return typeof targetTableId === "string" ? targetTableId : null;
};

const relationLabelFieldIds = (fields: Field[]): string[] => {
  const alive = fields.filter((field) => !field.deletedAt).sort((left, right) => left.position - right.position);
  const presentable = alive.filter((field) => field.presentable);
  if (presentable.length > 0) return presentable.map((field) => field.id);
  const firstText = alive.find((field) => field.type === "text");
  return firstText ? [firstText.id] : [];
};

export const customAppQueryPlanRelationTargetTableIds = (
  plan: DslResolvedSqlQueryPlan,
  fieldsByTableId: Record<string, Field[]>,
): string[] => {
  const byId = fieldMap(fieldsByTableId);
  const targets = new Set<string>();
  for (const fieldId of dslQueryReferencedFieldIds(plan, fieldsByTableId)) {
    const target = relationTargetId(byId.get(fieldId)!);
    if (target) targets.add(target);
  }
  return [...targets].sort();
};

/** Hash the resolved plan and the field metadata that can change what it reads. */
export const customAppQueryPlanHash = (plan: DslResolvedSqlQueryPlan, fieldsByTableId: Record<string, Field[]>): string => {
  const byId = fieldMap(fieldsByTableId);
  const ids = dslQueryReferencedFieldIds(plan, fieldsByTableId);
  const relationTargets: Array<{ fieldId: string; targetTableId: string; labelFieldIds: string[] }> = [];

  for (const fieldId of ids) {
    const field = byId.get(fieldId);
    if (!field) continue;
    const targetTableId = relationTargetId(field);
    if (!targetTableId) continue;
    const labelFieldIds = relationLabelFieldIds(fieldsByTableId[targetTableId] ?? []);
    relationTargets.push({ fieldId, targetTableId, labelFieldIds });
    for (const labelFieldId of labelFieldIds) ids.add(labelFieldId);
  }

  const fields = [...ids]
    .map((id) => byId.get(id))
    .filter((field): field is Field => field !== undefined)
    .map((field) => ({
      id: field.id,
      tableId: field.tableId,
      type: field.type,
      config: field.config,
      position: field.position,
      presentable: field.presentable,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  const payload = stableCustomAppValue({
    plan,
    fields,
    relationTargets: relationTargets.sort((left, right) => left.fieldId.localeCompare(right.fieldId)),
  });
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
};
