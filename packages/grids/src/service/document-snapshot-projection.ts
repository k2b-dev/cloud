import type { RecordSnapshot } from "../contracts";
import { projectPublicIds } from "./public-resources";

const objectValue = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const requiredPublicId = (ids: ReadonlyMap<string, string>, internalId: string, resource: string): string => {
  const id = ids.get(internalId);
  if (!id) throw new Error(`Grids could not project a public ${resource} id.`);
  return id;
};

type SnapshotConfigResource = "table" | "field" | "record" | "view" | "form";
const snapshotConfigResource = (key: string): SnapshotConfigResource | null => {
  if (/tableIds?$/i.test(key)) return "table";
  if (/fieldIds?$/i.test(key)) return "field";
  if (/recordIds?$/i.test(key)) return "record";
  if (/viewIds?$/i.test(key)) return "view";
  if (/formIds?$/i.test(key)) return "form";
  return null;
};

const collectSnapshotConfigIds = (value: unknown, target: Map<SnapshotConfigResource, Set<string>>, key = "") => {
  const resource = snapshotConfigResource(key);
  if (resource && typeof value === "string") {
    const ids = target.get(resource) ?? new Set<string>();
    ids.add(value);
    target.set(resource, ids);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSnapshotConfigIds(item, target, key.endsWith("s") ? key.slice(0, -1) : key);
    return;
  }
  const object = objectValue(value);
  if (object) for (const [nestedKey, nestedValue] of Object.entries(object)) collectSnapshotConfigIds(nestedValue, target, nestedKey);
};

const projectSnapshotConfigIds = (
  value: unknown,
  ids: ReadonlyMap<SnapshotConfigResource, ReadonlyMap<string, string>>,
  key = "",
): unknown => {
  const resource = snapshotConfigResource(key);
  if (resource && typeof value === "string") return requiredPublicId(ids.get(resource) ?? new Map(), value, resource);
  if (Array.isArray(value)) return value.map((item) => projectSnapshotConfigIds(item, ids, key.endsWith("s") ? key.slice(0, -1) : key));
  const object = objectValue(value);
  return object
    ? Object.fromEntries(
        Object.entries(object).map(([nestedKey, nestedValue]) => [nestedKey, projectSnapshotConfigIds(nestedValue, ids, nestedKey)]),
      )
    : value;
};

export const projectRecordSnapshot = async (snapshot: RecordSnapshot) => {
  const graph = objectValue(snapshot.graph);
  const graphRecords = objectValue(graph?.records);
  const snapshotRecords = [snapshot.root, ...Object.values(graphRecords ?? {})].map(objectValue).filter((value) => value !== null);
  const nestedTableIds = snapshotRecords.flatMap((record) => {
    const table = objectValue(record.table);
    return typeof table?.id === "string" ? [table.id] : [];
  });
  const nestedRecordIds = snapshotRecords.flatMap((record) => (typeof record.id === "string" ? [record.id] : []));
  const nestedFieldIds = snapshotRecords.flatMap((record) =>
    Array.isArray(record.fields)
      ? record.fields.flatMap((field) => {
          const value = objectValue(field);
          return typeof value?.id === "string" ? [value.id] : [];
        })
      : [],
  );
  const configIds = new Map<SnapshotConfigResource, Set<string>>();
  for (const record of snapshotRecords) {
    if (!Array.isArray(record.fields)) continue;
    for (const field of record.fields) {
      const config = objectValue(field)?.config;
      collectSnapshotConfigIds(config, configIds);
    }
  }
  const relationRecordIds = snapshotRecords.flatMap((record) => {
    const data = objectValue(record.data) ?? {};
    if (!Array.isArray(record.fields)) return [];
    return record.fields.flatMap((field) => {
      const value = objectValue(field);
      if (value?.type !== "relation" || typeof value.id !== "string") return [];
      const related = [data[value.id], value.defaultValue];
      return related.flatMap((candidate) =>
        Array.isArray(candidate)
          ? candidate.filter((id): id is string => typeof id === "string")
          : typeof candidate === "string"
            ? [candidate]
            : [],
      );
    });
  });
  const [snapshots, bases, tables, records, fields, views, forms] = await Promise.all([
    projectPublicIds("documentSnapshot", [snapshot.id]),
    projectPublicIds("base", [snapshot.baseId]),
    projectPublicIds("table", [snapshot.tableId, ...nestedTableIds, ...(configIds.get("table") ?? [])]),
    projectPublicIds("record", [snapshot.recordId, ...nestedRecordIds, ...relationRecordIds, ...(configIds.get("record") ?? [])]),
    projectPublicIds("field", [...nestedFieldIds, ...(configIds.get("field") ?? [])]),
    projectPublicIds("view", [...(configIds.get("view") ?? [])]),
    projectPublicIds("form", [...(configIds.get("form") ?? [])]),
  ]);
  const configPublicIds = new Map<SnapshotConfigResource, ReadonlyMap<string, string>>([
    ["table", tables],
    ["field", fields],
    ["record", records],
    ["view", views],
    ["form", forms],
  ]);
  const projectSnapshotRecord = (record: Record<string, unknown>): Record<string, unknown> => {
    const table = objectValue(record.table);
    const internalTableId = typeof table?.id === "string" ? table.id : null;
    const projectedFields = Array.isArray(record.fields)
      ? record.fields.map((field) => {
          const value = objectValue(field);
          if (!value || typeof value.id !== "string") return field;
          const { id, shortId: _shortId, config, ...rest } = value;
          return {
            ...rest,
            id: requiredPublicId(fields, id, "field"),
            config: projectSnapshotConfigIds(config, configPublicIds),
            defaultValue:
              value.type === "relation"
                ? Array.isArray(value.defaultValue)
                  ? value.defaultValue.map((recordId) =>
                      typeof recordId === "string" ? requiredPublicId(records, recordId, "record") : recordId,
                    )
                  : typeof value.defaultValue === "string"
                    ? requiredPublicId(records, value.defaultValue, "record")
                    : value.defaultValue
                : value.defaultValue,
          };
        })
      : [];
    const data = objectValue(record.data) ?? {};
    const projectedData = Object.fromEntries(
      Array.isArray(record.fields)
        ? record.fields.flatMap((field) => {
            const value = objectValue(field);
            if (!value || typeof value.id !== "string") return [];
            if (!Object.hasOwn(data, value.id)) return [];
            const publicFieldId = requiredPublicId(fields, value.id, "field");
            const raw = data[value.id];
            const projected =
              value.type === "relation"
                ? Array.isArray(raw)
                  ? raw.map((id) => (typeof id === "string" ? requiredPublicId(records, id, "record") : id))
                  : typeof raw === "string"
                    ? requiredPublicId(records, raw, "record")
                    : raw
                : raw;
            return [[publicFieldId, projected] as const];
          })
        : [],
    );
    const { id, ...rest } = record;
    return {
      ...rest,
      id: typeof id === "string" ? requiredPublicId(records, id, "record") : id,
      table: internalTableId ? { name: table?.name, id: requiredPublicId(tables, internalTableId, "table") } : table,
      fields: projectedFields,
      data: projectedData,
    };
  };
  const projectedRoot = projectSnapshotRecord(snapshot.root);
  const projectedRecords = Object.fromEntries(
    Object.values(graphRecords ?? {}).flatMap((record) => {
      const value = objectValue(record);
      if (!value || typeof value.id !== "string") return [];
      const table = objectValue(value.table);
      if (typeof table?.id !== "string") return [];
      const key = `${requiredPublicId(tables, table.id, "table")}:${requiredPublicId(records, value.id, "record")}`;
      return [[key, projectSnapshotRecord(value)] as const];
    }),
  );
  const { id: _id, shortId: _shortId, baseId, tableId, recordId, ...rest } = snapshot;
  return {
    ...rest,
    id: requiredPublicId(snapshots, snapshot.id, "document snapshot"),
    baseId: requiredPublicId(bases, baseId, "base"),
    tableId: requiredPublicId(tables, tableId, "table"),
    recordId: requiredPublicId(records, recordId, "record"),
    root: projectedRoot,
    graph: {
      rootId: `${requiredPublicId(tables, tableId, "table")}:${requiredPublicId(records, recordId, "record")}`,
      records: projectedRecords,
    },
  };
};
