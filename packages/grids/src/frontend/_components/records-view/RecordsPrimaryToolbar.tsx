import { Button, ButtonLink, Dropdown, Tooltip } from "@k2b/ui";
import { Show } from "solid-js";
import type { PublicField as Field } from "../../../api/public-dto";
import { CardSizeDropdown } from "../toolbar/CardSizeDropdown";
import SearchBar from "../toolbar/SearchBar";
import type { PublicWorkspaceBulkLauncher as WorkspaceBulkLauncher } from "../workspace/workspace-public-state-model";
import { bulkWorkflowActionLabel } from "./bulk-selection";
import type { CardSize, RecordsState } from "./query-url";

type Props = {
  searchableFields: Field[];
  search: RecordsState["search"];
  trashMode: boolean;
  canReadTable: boolean;
  tableKind: "stored" | "federated";
  baseId: string;
  tableId: string;
  recordCountText: string;
  livePending: boolean;
  liveRefreshing: boolean;
  cardsMode: boolean;
  viewMode: boolean;
  cardSize: CardSize;
  recordMetaCount: number;
  bulkSelectionEnabled: boolean;
  selectedBulkCount: number;
  bulkQueueing: boolean;
  bulkLaunchers: WorkspaceBulkLauncher[];
  queryHref: string;
  onSearchChange: (next: { q: string; fieldIds: string[] }) => void;
  onRefresh: () => void;
  onCardSizeChange: (size: CardSize) => void;
  onOpenRecordMetadata: () => void;
  onClearBulkSelection: () => void;
  onQueueBulkWorkflow: (launcher: WorkspaceBulkLauncher) => void;
  onExport: () => void;
  onOpenCombinedAudit: () => void;
};

export default function RecordsPrimaryToolbar(props: Props) {
  return (
    <div class="flex flex-wrap items-center gap-2 shrink-0">
      <Show when={props.searchableFields.length > 0}>
        <div class="flex-1 min-w-0">
          <SearchBar
            fields={props.searchableFields}
            initialQ={props.search.q}
            initialQFields={props.search.fieldIds}
            onSearchChange={props.onSearchChange}
          />
        </div>
      </Show>

      <span class="text-xs text-dimmed whitespace-nowrap">
        {props.trashMode && "Deleted: "}
        {props.recordCountText}
      </span>
      <Show when={props.livePending || props.liveRefreshing}>
        <Tooltip.Anchor content="Refresh records">
          <Button
            variant="secondary"
            size="sm"
            type="button"
            class="app-accent-text"
            disabled={props.liveRefreshing}
            onClick={props.onRefresh}
          >
            <i class={`ti ${props.liveRefreshing ? "ti-loader-2 animate-spin" : "ti-refresh"}`} />
            Updates available
          </Button>
        </Tooltip.Anchor>
      </Show>
      <Show when={props.cardsMode && (props.viewMode || props.trashMode)}>
        <CardSizeDropdown value={props.cardSize} onChange={props.onCardSizeChange} />
      </Show>

      <Show
        when={!props.trashMode}
        fallback={
          <Show when={props.canReadTable}>
            <ButtonLink variant="secondary" size="sm" href={`/app/grids/${props.baseId}/table/${props.tableId}`}>
              <i class="ti ti-arrow-back" />
              Back to live records
            </ButtonLink>
          </Show>
        }
      >
        <Show when={props.recordMetaCount > 0}>
          <Button variant="secondary" size="sm" aria-pressed="true" type="button" onClick={props.onOpenRecordMetadata}>
            <i class="ti ti-user-search" />
            Record info · {props.recordMetaCount}
          </Button>
        </Show>
        <Show when={props.bulkSelectionEnabled && props.selectedBulkCount > 0}>
          <Button variant="secondary" size="sm" aria-pressed="true" type="button" onClick={props.onClearBulkSelection}>
            <i class="ti ti-checklist" />
            {props.selectedBulkCount} selected
            <i class="ti ti-x text-[10px] opacity-60" />
          </Button>
        </Show>
        <Dropdown.Root
          position="bottom-left"
          items={[
            {
              sectionLabel: "Records",
              items: [
                { icon: "ti ti-user-search", label: "Record metadata", action: props.onOpenRecordMetadata },
                { icon: "ti ti-download", label: "Export records", action: props.onExport },
              ],
            },
            ...(props.bulkLaunchers.length > 0
              ? [
                  {
                    sectionLabel: "Workflows",
                    items: props.bulkLaunchers.map((launcher) => {
                      const label = bulkWorkflowActionLabel(
                        launcher.name,
                        props.selectedBulkCount,
                        launcher.config.kind === "bulk" && "profile" in launcher.config && launcher.config.profile === "closeSelection",
                      );
                      return props.bulkQueueing
                        ? { icon: "ti ti-loader-2 animate-spin", label: `Preparing ${launcher.name}`, disabled: true as const }
                        : { icon: "ti ti-route", label, action: () => props.onQueueBulkWorkflow(launcher) };
                    }),
                  },
                ]
              : []),
            {
              sectionLabel: "Explore",
              items: [
                { icon: "ti ti-code", label: "Open query", href: props.queryHref },
                ...(props.tableKind === "federated" && props.canReadTable
                  ? [{ icon: "ti ti-history", label: "Audit trail", action: props.onOpenCombinedAudit }]
                  : []),
                ...(props.canReadTable
                  ? [
                      {
                        icon: "ti ti-archive",
                        label: "Show deleted",
                        href: `/app/grids/${props.baseId}/table/${props.tableId}?trash=1`,
                      },
                    ]
                  : []),
              ],
            },
          ]}
        >
          <Dropdown.Trigger variant="secondary" size="sm">
            Actions
            <i class="ti ti-chevron-down text-[10px] opacity-60" />
          </Dropdown.Trigger>
        </Dropdown.Root>
      </Show>
    </div>
  );
}
