import { Select, useLocale } from "@k2b/ui";
import { recordMessages } from "./messages";
import { fetchRecordLookup } from "./record-lookup";

type Props = {
  tableId: string;
  templateId?: string;
  value: () => string;
  onChange: (recordId: string) => void;
  label?: string;
  description?: string;
  placeholder?: string;
  selectedLabel?: () => string | undefined;
  disabled?: () => boolean;
  excludeIds?: () => string[];
  clearable?: boolean;
  includeDeleted?: boolean;
  required?: boolean;
  error?: () => string | undefined;
};

export default function RecordPicker(props: Props) {
  const locale = useLocale();
  const t = () => recordMessages.resolve([locale()]).t;
  const excludedIds = () => [...new Set([props.value(), ...(props.excludeIds?.() ?? [])].filter(Boolean))];

  return (
    <Select
      label={props.label}
      description={props.description}
      required={props.required}
      error={props.error}
      placeholder={props.placeholder ?? t().searchRecords}
      icon="ti ti-database"
      activeIcon="ti ti-search"
      clearable={props.clearable ?? true}
      disabled={props.disabled?.() ?? false}
      value={() => props.value()}
      onValueChange={(recordId) => props.onChange(recordId ?? "")}
      selectedLabel={props.selectedLabel}
      fetchData={async (query, signal) => {
        const items = await fetchRecordLookup({
          tableId: props.tableId,
          templateId: props.templateId,
          query,
          excludeIds: excludedIds(),
          includeDeleted: props.includeDeleted,
          signal,
          locale: locale(),
        });
        return items.map((item) => ({ id: item.id, label: item.label, icon: "ti ti-database" }));
      }}
    />
  );
}
