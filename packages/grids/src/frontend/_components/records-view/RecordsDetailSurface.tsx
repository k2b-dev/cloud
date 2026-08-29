import type { DateContext } from "@k2b/stdlib";
import { Button, Placeholder, useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import type { PublicField as Field, PublicGridRecord as GridRecord } from "../../../api/public-dto";
import type { AggregationSpec, ColumnSpec, GroupBySpec, RecordQuery, TableAuditPolicy } from "../../../contracts";
import type { PublicDocumentTemplateSummary } from "../documents/public-document-types";
import RecordDetailPanel from "../records/RecordDetailPanel";
import GroupDetailPanel from "../table/GroupDetailPanel";
import type { GroupBucket } from "../table/GroupedTable";
import type {
  PublicWorkspaceRecordDetail as WorkspaceRecordDetail,
  PublicWorkspaceRecordLauncher as WorkspaceRecordLauncher,
} from "../workspace/workspace-public-state-model";
import { recordsViewMessages } from "./messages";

type Props = {
  cloudUrl: string;
  baseId: string;
  tableId: string;
  tableName: string;
  fields: Field[];
  auditPolicy: TableAuditPolicy;
  record: () => GridRecord | null;
  detail: () => WorkspaceRecordDetail | null;
  recordFailure: Error | null;
  selectedGroup: GroupBucket | null;
  query: RecordQuery;
  groupBy: GroupBySpec[];
  aggregations: AggregationSpec[];
  documentTemplates: PublicDocumentTemplateSummary[];
  mode: () => "live" | "trash";
  canWrite: boolean;
  canRunWorkflows: boolean;
  relationLabels: Record<string, string>;
  fieldsByTable: Record<string, Field[]>;
  viewColumns: ColumnSpec[] | undefined;
  dateConfig?: DateContext;
  onCloseRecord: () => void;
  onRetryRecord: () => void;
  onRecordUpdated: (record: GridRecord) => void;
  onRecordRemoved: () => void;
  recordActionLaunchers: WorkspaceRecordLauncher[];
  onOpenRecord: (recordId: string) => void;
  onCloseGroup: () => void;
  onOpenGroupedRecord: (record: GridRecord) => void;
};

export default function RecordsDetailSurface(props: Props) {
  const locale = useLocale();
  const t = () => recordsViewMessages.resolve([locale()]).t;
  const fieldsByTable = () => ({ ...props.fieldsByTable, [props.tableId]: props.fields });

  return (
    <Show
      when={props.selectedGroup}
      fallback={
        <Show
          when={!props.recordFailure}
          fallback={
            <Placeholder
              state="error"
              surface="paper"
              title={t().loadRecordFailed}
              description={props.recordFailure?.message}
              class="h-full"
              action={
                <div class="flex items-center gap-1">
                  <Button variant="secondary" size="sm" type="button" onClick={props.onCloseRecord}>
                    {t().close}
                  </Button>
                  <Button variant="secondary" size="sm" type="button" onClick={props.onRetryRecord}>
                    <i class="ti ti-refresh" aria-hidden="true" /> {t().retry}
                  </Button>
                </div>
              }
            />
          }
        >
          <Show
            when={props.record()}
            fallback={<Placeholder state="loading" surface="paper" variant="panel" title={t().loadingRecord} class="m-3" />}
          >
            <RecordDetailPanel
              cloudUrl={props.cloudUrl}
              baseId={props.baseId}
              tableId={props.tableId}
              tableName={props.tableName}
              fields={props.fields}
              auditPolicy={props.auditPolicy}
              record={props.record}
              detail={props.detail}
              documentTemplates={props.documentTemplates}
              mode={props.mode}
              canWrite={props.canWrite}
              canRunWorkflows={props.canRunWorkflows}
              relationLabels={props.relationLabels}
              fieldsByTable={fieldsByTable()}
              viewColumns={props.viewColumns}
              onClose={props.onCloseRecord}
              onUpdated={props.onRecordUpdated}
              onRemoved={props.onRecordRemoved}
              recordActionLaunchers={props.recordActionLaunchers}
              onOpenRecord={props.onOpenRecord}
              dateConfig={props.dateConfig}
            />
          </Show>
        </Show>
      }
    >
      {(bucket) => (
        <GroupDetailPanel
          tableId={props.tableId}
          fields={props.fields}
          query={props.query}
          groupBy={props.groupBy}
          aggregations={props.aggregations}
          bucket={bucket()}
          relationLabels={props.relationLabels}
          onClose={props.onCloseGroup}
          onOpenRecord={props.onOpenGroupedRecord}
          dateConfig={props.dateConfig}
        />
      )}
    </Show>
  );
}
