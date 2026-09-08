import type { CustomAppCapabilities } from "../custom-apps/contracts";
import { listByTables } from "./fields";
import { buildPrincipalLabelCache, principalReferencesFromRecords } from "./principal-values";
import type { ExpansionViewer } from "./relation-access";
import { buildPinnedRelationLabelCache } from "./relation-labels";
import { relationLabelFields } from "./relation-targets";
import { get as getTable } from "./tables";
import type { Field, GridRecord } from "./types";

type CustomAppRecordRelation = CustomAppCapabilities["records"][number]["relationLabels"][number];

const relationTargetTableId = (field: Field): string | null => {
  if (field.type !== "relation" || field.deletedAt) return null;
  const targetTableId = (field.config as { targetTableId?: unknown }).targetTableId;
  return typeof targetTableId === "string" ? targetTableId : null;
};

export const customAppRecordRelationSnapshot = (
  fields: readonly Field[],
  targetFieldsByTableId: ReadonlyMap<string, readonly Field[]>,
): CustomAppRecordRelation[] =>
  fields
    .flatMap((field) => {
      const targetTableId = relationTargetTableId(field);
      if (!targetTableId) return [];
      return [
        {
          fieldId: field.id,
          targetTableId,
          labelFieldIds: relationLabelFields([...(targetFieldsByTableId.get(targetTableId) ?? [])]).map((target) => target.id),
        },
      ];
    })
    .sort((left, right) => left.fieldId.localeCompare(right.fieldId));

export const sameCustomAppRecordRelationSnapshot = (
  left: readonly CustomAppRecordRelation[],
  right: readonly CustomAppRecordRelation[],
): boolean =>
  left.length === right.length &&
  left.every(
    (relation, index) =>
      relation.fieldId === right[index]?.fieldId &&
      relation.targetTableId === right[index]?.targetTableId &&
      relation.labelFieldIds.join("\0") === right[index]?.labelFieldIds.join("\0"),
  );

export const customAppRelationLabelFieldIdsByTableId = (
  relations: readonly CustomAppRecordRelation[],
): ReadonlyMap<string, readonly string[]> => new Map(relations.map((relation) => [relation.targetTableId, relation.labelFieldIds]));

export const customAppRecordRelationsMatchPublished = async (params: {
  baseId: string;
  fields: readonly Field[];
  relations: readonly CustomAppRecordRelation[];
}): Promise<boolean> => {
  const targetTableIds = [...new Set(params.relations.map((relation) => relation.targetTableId))];
  const tables = await Promise.all(targetTableIds.map((id) => getTable(id)));
  if (tables.some((table) => !table || table.baseId !== params.baseId)) return false;
  const targetFields = await listByTables(targetTableIds);
  return sameCustomAppRecordRelationSnapshot(params.relations, customAppRecordRelationSnapshot(params.fields, targetFields));
};

export const buildCustomAppRecordLabelCache = async (params: {
  records: GridRecord[];
  fields: Field[];
  relations: readonly CustomAppRecordRelation[];
  viewer: ExpansionViewer;
  actorUserId: string | null;
}): Promise<Record<string, string>> => ({
  ...(await buildPinnedRelationLabelCache(
    params.records,
    params.fields,
    customAppRelationLabelFieldIdsByTableId(params.relations),
    params.viewer,
  )),
  ...(await buildPrincipalLabelCache(principalReferencesFromRecords(params.records, params.fields), params.actorUserId)),
});
