import type { DateContext } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { type Action, Bar, Button, Canvas, Failed, Loading, Pane, Text } from "@k2b/ui/v2";
import { type JSX, Show } from "solid-js";
import type { PublicField as Field, PublicGridRecord as GridRecord } from "../../../api/public-dto";
import type { AggregationSpec, ColumnSpec, GroupBySpec, RecordQuery, TableAuditPolicy } from "../../../contracts";
import type { PublicDocumentTemplateSummary } from "../documents/public-document-types";
import RecordDetailPanel from "../records/RecordDetailPanel";
import type { RecordAccess } from "../records/record-access";
import GroupDetailPanel from "../table/GroupDetailPanel";
import type { GroupBucket } from "../table/GroupedTable";
import type {
  PublicWorkspaceRecordDetail as WorkspaceRecordDetail,
  PublicWorkspaceRecordLauncher as WorkspaceRecordLauncher,
} from "../workspace/workspace-public-state-model";
import { recordsViewMessages } from "./messages";

type Props = {
  baseId: string;
  tableId: string;
  tableName: string;
  /** Fields of the active view's output. */
  fields: Field[];
  /** Every field of the table, which group members need to show their own label. */
  tableFields: Field[];
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
  /** Server time for the same history on the server and the first browser render. */
  now?: string;
  onCloseRecord: () => void;
  onRetryRecord: () => void;
  onRecordUpdated: (record: GridRecord) => void;
  onRecordRemoved: () => void;
  recordActionLaunchers: WorkspaceRecordLauncher[];
  onOpenRecord: (recordId: string) => void;
  onCloseGroup: () => void;
  onOpenGroupedRecord: (record: GridRecord) => void;
  /** Who has access to the base, read-only. */
  access?: RecordAccess;
  currentUserId?: string;
  /** The way back to the list on the phone: the list's address without the open entry. */
  back: Action;
};

/**
 * The detail beside the records on v2: the open record, or the members of an open group. While the record loads it
 * holds its place; a record that fails to load says so with a way to retry.
 */
export default function RecordsDetailSurface(props: Props) {
  const locale = useLocale();
  const t = () => recordsViewMessages.resolve([locale()]).t;
  const fieldsByTable = () => ({ ...props.fieldsByTable, [props.tableId]: props.fields });
  const frame = (label: string, onClose: () => void, children: () => JSX.Element) => (
    <Pane
      detail
      label={label}
      width={{ min: 400, default: 480 }}
      back={props.back}
      head={<Bar start={<Text type="body">{label}</Text>} end={<Button variant="ghost" icon="x" label={t().close} onClick={onClose} />} />}
    >
      {children()}
    </Pane>
  );

  return (
    <Show
      when={props.selectedGroup}
      fallback={
        <Show
          when={!props.recordFailure}
          fallback={frame(t().loadRecordFailed, props.onCloseRecord, () => (
            <Failed text={props.recordFailure?.message ?? t().loadRecordFailed} onRetry={props.onRetryRecord} />
          ))}
        >
          <Show when={props.record()} fallback={frame(t().loadingRecord, props.onCloseRecord, () => <Loading rows={6} lines={2} />)}>
            <RecordDetailPanel
              baseId={props.baseId}
              tableId={props.tableId}
              tableName={props.tableName}
              fields={props.fields}
              auditPolicy={props.auditPolicy}
              record={props.record}
              detail={props.detail}
              now={props.now}
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
              access={props.access}
              currentUserId={props.currentUserId}
              back={props.back}
            />
          </Show>
        </Show>
      }
    >
      {(bucket) => (
        <Pane
          detail
          label={t().groupMembers}
          width={{ min: 400, default: 480 }}
          back={props.back}
          head={
            <Bar
              start={<Text type="body">{t().groupMembers}</Text>}
              end={<Button variant="ghost" icon="x" label={t().close} onClick={props.onCloseGroup} />}
            />
          }
        >
          {/* k2b-ui gap: a group's summary and members wait for the v2 grouped table (lane MW); its panel stays. */}
          <Canvas label={t().groupMembers}>
            <GroupDetailPanel
              tableId={props.tableId}
              fields={props.tableFields}
              query={props.query}
              groupBy={props.groupBy}
              aggregations={props.aggregations}
              bucket={bucket()}
              relationLabels={props.relationLabels}
              onClose={props.onCloseGroup}
              onOpenRecord={props.onOpenGroupedRecord}
              dateConfig={props.dateConfig}
            />
          </Canvas>
        </Pane>
      )}
    </Show>
  );
}
