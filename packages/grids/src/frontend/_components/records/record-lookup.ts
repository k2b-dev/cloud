import { apiClient } from "@/api/client";
import type { RelationLookupItem } from "../../../contracts";
import { recordMessages } from "./messages";

export type RecordLookupItem = RelationLookupItem;

export const fetchRecordLookup = async (params: {
  tableId: string;
  templateId?: string;
  query: string;
  excludeIds?: string[];
  limit?: number;
  includeDeleted?: boolean;
  signal: AbortSignal;
  locale?: string;
}): Promise<RecordLookupItem[]> => {
  const { t } = recordMessages.resolve([params.locale ?? "en"]);
  if (params.templateId) {
    const res = await apiClient.documents.templates[":templateId"].records.lookup.$get(
      {
        param: { templateId: params.templateId },
        query: {
          q: params.query,
          excludeIds: (params.excludeIds ?? []).join(","),
          limit: String(params.limit ?? 10),
        },
      },
      { init: { signal: params.signal } },
    );
    if (!res.ok) {
      if (res.status === 403) throw new Error(t.documentRecordLookupDenied);
      throw new Error(t.recordLookupFailed);
    }
    const data = (await res.json()) as { items: RecordLookupItem[] };
    return data.items;
  }
  const res = await apiClient.tables[":tableId"].lookup.$get(
    {
      param: { tableId: params.tableId },
      query: {
        q: params.query,
        excludeIds: (params.excludeIds ?? []).join(","),
        limit: String(params.limit ?? 10),
        ...(params.includeDeleted ? { includeDeleted: "true" as const } : {}),
      },
    },
    { init: { signal: params.signal } },
  );
  if (!res.ok) {
    if (res.status === 403) {
      throw new Error(t.tableRecordLookupDenied);
    }
    throw new Error(t.recordLookupFailed);
  }
  const data = await res.json();
  return data.items;
};
