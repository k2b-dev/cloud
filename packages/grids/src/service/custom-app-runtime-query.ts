import { runWithQueryAdmissionSignal } from "../api/query-admission";
import type { DslQueryPreviewResponse } from "../contracts";
import { customAppViewSourceHash } from "../custom-apps/insight-source";
import type { DslQueryContextValues } from "../query-dsl/parameters";
import { previewDslQuery } from "../query-dsl/preview";
import type { DslResultCursor } from "../query-dsl/result-cursor";
import { collectDslPlanTableIds } from "../query-dsl/source-plan";
import { compileCustomAppQuery } from "./custom-app-query";
import type { ExpansionViewer } from "./relations";

type PublishedQueryCapability = {
  sourceHash?: string;
  planHash: string;
  tableIds: readonly string[];
};

const diagnostic = (message: string): DslQueryPreviewResponse => ({ ok: false, diagnostics: [{ message }] });
const sameIds = (left: readonly string[], right: readonly string[]): boolean =>
  [...left].sort().join("\0") === [...right].sort().join("\0");

/**
 * Execute only a source loaded from an immutable published definition. This is
 * intentionally a server-only service: callers cannot submit arbitrary GQL.
 */
export const executePublishedCustomAppQuery = async (params: {
  baseId: string;
  source: string;
  capability: PublishedQueryCapability;
  context: DslQueryContextValues;
  signal: AbortSignal;
  timeZone: string;
  viewer: ExpansionViewer;
  currentTableId?: string;
  sourceHashScope?: string;
  maxRows: number;
  pageSize?: number;
  cursor?: DslResultCursor | null;
  cursorFingerprint?: string;
  cursorSigningKey?: string;
  search?: { q: string; allowedFieldIds?: readonly string[] };
  maxResultBytes: number;
  labelRelationValues?: boolean;
}): Promise<DslQueryPreviewResponse> => {
  if (
    params.capability.sourceHash &&
    customAppViewSourceHash(params.sourceHashScope ?? params.baseId, params.source) !== params.capability.sourceHash
  ) {
    return diagnostic("This published data source no longer matches its capability snapshot.");
  }

  const compiled = await compileCustomAppQuery({
    baseId: params.baseId,
    source: params.source,
    context: params.context,
    ...(params.currentTableId ? { currentTableId: params.currentTableId } : {}),
  });
  if (!compiled.ok) return diagnostic(compiled.error);
  if (compiled.data.planHash !== params.capability.planHash) {
    return diagnostic("This published data source no longer matches its query plan capability snapshot.");
  }

  const planTableIds = collectDslPlanTableIds(compiled.data.plan, compiled.data.fieldsByTableId);
  if (!sameIds(planTableIds, params.capability.tableIds)) {
    return diagnostic("This published data source no longer matches its table capability snapshot.");
  }

  const authorizedTableIds = new Set(params.capability.tableIds);
  const allowedFieldIds = params.search?.allowedFieldIds ? new Set(params.search.allowedFieldIds) : null;
  const selected = compiled.data.plan.outputColumns ?? [];
  const selectedPrimaryFieldIds = [
    ...new Set(
      (selected.length > 0
        ? selected.filter((column) => column.kind === "field").map((column) => column.fieldId)
        : (compiled.data.plan.query.columns ?? []).flatMap((column) => ("fieldId" in column ? [column.fieldId] : []))
      ).filter((fieldId) => !allowedFieldIds || allowedFieldIds.has(fieldId)),
    ),
  ];
  const primaryFieldIds = allowedFieldIds
    ? (compiled.data.fieldsByTableId[compiled.data.plan.tableId] ?? [])
        .map((field) => field.id)
        .filter((fieldId) => allowedFieldIds.has(fieldId))
    : selectedPrimaryFieldIds;
  const joinedByAlias = new Map<string, { tableId: string; joinAlias: string; fieldIds: string[] }>();
  for (const column of selected) {
    if (column.kind !== "joined" || (allowedFieldIds && !allowedFieldIds.has(column.fieldId))) continue;
    const group = joinedByAlias.get(column.joinAlias) ?? {
      tableId: column.tableId,
      joinAlias: column.joinAlias,
      fieldIds: [],
    };
    if (!group.fieldIds.includes(column.fieldId)) group.fieldIds.push(column.fieldId);
    joinedByAlias.set(column.joinAlias, group);
  }
  const result = await runWithQueryAdmissionSignal(params.signal, (signal) =>
    previewDslQuery(compiled.data.plan, {
      fieldsByTableId: compiled.data.fieldsByTableId,
      timeZone: params.timeZone,
      maxRows: params.maxRows,
      pageSize: params.pageSize ?? params.maxRows,
      cursor: params.cursor,
      cursorFingerprint: params.cursorFingerprint,
      cursorSigningKey: params.cursorSigningKey,
      ...(params.search
        ? {
            runtimeSearch: {
              q: params.search.q,
              primaryFieldIds,
              joined: [...joinedByAlias.values()],
            },
          }
        : {}),
      maxResultBytes: params.maxResultBytes,
      signal,
      labelRelationValues: params.labelRelationValues,
      viewer: {
        ...params.viewer,
        isAdmin: false,
        readableTableIds: authorizedTableIds,
        tableReadAccess: new Map([...authorizedTableIds].map((tableId) => [tableId, true])),
      },
      authorizedTableIds,
      primaryTableAuthorized: true,
    }),
  );
  return result.ok ? result.data : diagnostic(result.error.message);
};

export const publishedCustomAppAvailability = async (
  params: Omit<Parameters<typeof executePublishedCustomAppQuery>[0], "maxRows" | "maxResultBytes" | "labelRelationValues">,
): Promise<boolean> => {
  try {
    const response = await executePublishedCustomAppQuery({ ...params, maxRows: 1, maxResultBytes: 64_000 });
    return response.ok && response.rows.length > 0;
  } catch {
    return false;
  }
};
