import { useCloudIdCopy } from "@k2b/cloud/browser/cloud-id";
import { Dropdown, IconButton, useLocale } from "@k2b/ui";
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import type { PublicField as Field } from "../../../api/public-dto";
import { bulkWorkflowActionLabel } from "../records-view/bulk-selection";
import { recordsViewMessages } from "../records-view/messages";
import { onRecordsHeadStatus, type RecordsHeadStatus, sendRecordsHeadCommand } from "../records-view/records-head-bus";
import { toolbarMessages } from "../toolbar/messages";
import SearchBar from "../toolbar/SearchBar";

/** A bulk launcher as the head's menu needs it; the records view queues the full launcher by id. */
export type RecordsHeadLauncher = { id: string; name: string; closesSelection: boolean };

type Props = {
  baseId: string;
  tableId: string;
  tableName: string;
  tableKind: "stored" | "federated";
  searchableFields: Field[];
  initialSearch: { q: string; fieldIds: string[] };
  trashMode: boolean;
  canReadTable: boolean;
  queryHref: string;
  bulkLaunchers: RecordsHeadLauncher[];
};

/**
 * The records page's head actions (K6): the search, then "⋯" with what acts on the table's records. The records view
 * below owns the query and the dialogs; this island sends it commands and follows its status (records-head-bus).
 */
export default function RecordsHeadActions(props: Props) {
  const locale = useLocale();
  const t = () => recordsViewMessages.resolve([locale()]).t;
  const cloudId = useCloudIdCopy();
  const [status, setStatus] = createSignal<RecordsHeadStatus>({
    busy: false,
    search: props.initialSearch,
    searchableFields: props.searchableFields,
    selectedCount: 0,
    queueing: false,
  });
  onMount(() => onCleanup(onRecordsHeadStatus(props.tableId, setStatus)));
  // The bar resets its typing buffer when its initial values change, so they change only when the search does.
  const search = createMemo(() => status().search, undefined, {
    equals: (a, b) => a.q === b.q && a.fieldIds.join() === b.fieldIds.join(),
  });
  const fields = createMemo(() => status().searchableFields, undefined, {
    equals: (a, b) => a.map((field) => `${field.id}:${field.name}`).join() === b.map((field) => `${field.id}:${field.name}`).join(),
  });
  const send = (command: Parameters<typeof sendRecordsHeadCommand>[1]) => sendRecordsHeadCommand(props.tableId, command);
  // K15: in a narrow head the search waits behind its symbol and opens as a row under the head; an active search stays
  // open, so what narrows the records is always in sight.
  const [searchOpen, setSearchOpen] = createSignal(Boolean(props.initialSearch.q));
  const searchId = `grids-records-search-${props.tableId}`;

  return (
    <div class="grids-records-head-actions" data-search-open={searchOpen() || search().q ? "" : undefined}>
      <Show when={fields().length > 0}>
        <span class="grids-records-head-search-toggle">
          <IconButton
            variant="ghost"
            size="sm"
            label={toolbarMessages.resolve([locale()]).t.searchRecords}
            aria-expanded={searchOpen() || Boolean(search().q)}
            aria-controls={searchId}
            onClick={() => setSearchOpen((open) => !open)}
          >
            <i class="ti ti-search" aria-hidden="true" />
          </IconButton>
        </span>
        <div class="grids-records-head-search" id={searchId}>
          <SearchBar
            tableName={props.tableName}
            fields={fields()}
            initialQ={search().q}
            initialQFields={search().fieldIds}
            busy={status().busy}
            onSearchChange={(next) => send({ kind: "search", ...next })}
          />
        </div>
      </Show>
      <Show when={!props.trashMode}>
        <Dropdown.Root
          position="bottom-left"
          items={[
            {
              sectionLabel: t().records,
              items: [
                { icon: "ti ti-user-search", label: t().recordMetadata, action: () => send({ kind: "metadata" }) },
                { icon: "ti ti-download", label: t().exportRecords, action: () => send({ kind: "export" }) },
              ],
            },
            ...(props.bulkLaunchers.length > 0
              ? [
                  {
                    sectionLabel: t().workflows,
                    items: props.bulkLaunchers.map((launcher) =>
                      status().queueing
                        ? { icon: "ti ti-loader-2 animate-spin", label: t().preparing({ name: launcher.name }), disabled: true as const }
                        : {
                            icon: "ti ti-route",
                            label: bulkWorkflowActionLabel(launcher.name, status().selectedCount, launcher.closesSelection, locale()),
                            action: () => send({ kind: "workflow", launcherId: launcher.id }),
                          },
                    ),
                  },
                ]
              : []),
            {
              sectionLabel: t().explore,
              items: [
                { icon: "ti ti-code", label: t().openQuery, href: props.queryHref },
                ...(props.tableKind === "federated" && props.canReadTable
                  ? [{ icon: "ti ti-history", label: t().auditTrail, action: () => send({ kind: "audit" }) }]
                  : []),
                ...(props.canReadTable
                  ? [{ icon: "ti ti-archive", label: t().showDeleted, href: `/app/grids/${props.baseId}/table/${props.tableId}?trash=1` }]
                  : []),
              ],
            },
            ...cloudId.section({ type: "grids.table", id: props.tableId }),
          ]}
        >
          <Dropdown.Trigger iconOnly label={t().actions} variant="ghost">
            <i class="ti ti-dots" aria-hidden="true" />
          </Dropdown.Trigger>
        </Dropdown.Root>
      </Show>
    </div>
  );
}
