import { MultiSelectInput, type MultiSelectOption, useLocale } from "@k2b/ui";
import { recordMessages } from "./messages";
import RecordPicker from "./RecordPicker";
import { fetchRecordLookup, type RecordLookupItem } from "./record-lookup";

/**
 * Relation picker — search-driven dropdown over a target table.
 *
 * The picker is "controlled" in the React/Solid sense — `value` and
 * `onChange` flow from the parent. The parent (RecordDetailPanel) is
 * responsible for persisting the new id-array via PATCH /records/:id.
 *
 * Single vs multi:
 * - `multi=false` → renders the platform's `Select` with `fetchData`.
 *   The Select's built-in dropdown / search / loading / error UI
 *   matches every other select in the platform — visual consistency for
 *   free.
 * - `multi=true` → renders the platform's `MultiSelectInput` in async
 *   mode, so relation pickers use the same searchable dropdown pattern
 *   as the rest of cloud-ui.
 */
type LookupItem = RecordLookupItem;

type Props = {
  /** Target table to search records of. */
  targetTableId: string;
  /** Currently-linked record ids. Empty array = nothing linked. */
  value: () => string[];
  /** Pre-resolved labels for the currently-linked ids — passed in by
   *  the parent (RecordDetailPanel reuses the SSR-built relationLabels
   *  cache). Missing entries fall back to an 8-char id prefix. */
  labels: () => Record<string, string>;
  /** True = multi-relation (array of ids). False = single (single-id
   *  array, picker replaces on select). Maps to the relation field's
   *  cardinality config. */
  multi: boolean;
  /** Emit the new id list to the parent. The parent persists. */
  onChange: (next: string[]) => void;
  /** True while the parent's PATCH is in-flight; greys out the picker. */
  saving?: () => boolean;
  /** Extra ids to hide from the dropdown, e.g. the record currently being edited for self-relations. */
  excludeIds?: () => string[];
};

export default function RelationPicker(props: Props) {
  const locale = useLocale();
  const t = () => recordMessages.resolve([locale()]).t;
  const excludedIds = () => [...new Set([...props.value(), ...(props.excludeIds?.() ?? [])])];
  const labelFor = (id: string): string => {
    const fromProp = props.labels()[id];
    if (fromProp) return fromProp;
    return t().unavailableRecord;
  };

  const toOption = (item: LookupItem): MultiSelectOption => ({ id: item.id, label: item.label, icon: "ti ti-link" });

  // ── Single-cardinality path ─────────────────────────────────────────
  // Thin wrapper around Select. The platform's Select already
  // owns search / debounce / loading / error / abort via its mutation-
  // backed `fetchData` prop, so this is just glue: array<->string for
  // the value, and a label resolver for the selected-display fallback.
  if (!props.multi) {
    return (
      <RecordPicker
        tableId={props.targetTableId}
        placeholder={t().pickLinkedRecord}
        clearable
        disabled={() => props.saving?.() ?? false}
        value={() => props.value()[0] ?? ""}
        onChange={(id) => props.onChange(id ? [id] : [])}
        selectedLabel={() => {
          const id = props.value()[0];
          return id ? labelFor(id) : undefined;
        }}
        excludeIds={excludedIds}
      />
    );
  }

  // ── Multi-cardinality path ──────────────────────────────────────────
  return (
    <MultiSelectInput
      aria-label={t().linkedRecords}
      placeholder={t().addLinkedRecords}
      icon="ti ti-link"
      activeIcon="ti ti-link"
      clearable
      disabled={props.saving?.() ?? false}
      value={props.value}
      onValueChange={props.onChange}
      selectedOptions={() => props.value().map((id) => ({ id, label: labelFor(id), icon: "ti ti-link" }))}
      fetchData={async (q, signal) => {
        const items = await fetchRecordLookup({
          tableId: props.targetTableId,
          query: q,
          excludeIds: excludedIds(),
          signal,
          locale: locale(),
        });
        return items.map(toOption);
      }}
    />
  );
}
