import { timed as timing } from "@k2b/stdlib/solid";
import { MultiSelectInput, TextInput, useLocale } from "@k2b/ui";
import { createEffect, createSignal, Show } from "solid-js";
import type { PublicField as Field } from "../../../api/public-dto";
import { fieldChoiceGroupsFor, fieldTypeGroups } from "../fields/field-type-meta";
import { toolbarMessages } from "./messages";

type Props = {
  /** Fields the server-side search compiler can search. */
  fields: Field[];
  /** Current search text from the URL (`?q=...`). */
  initialQ: string;
  /** Field ids the search is currently scoped to (`?qFields=csv`). Empty = all. */
  initialQFields: string[];
  /**
   * Emit the current free-text search shape to the parent (RecordsView)
   * which owns the canonical query state + URL sync. The bar keeps its
   * debounce so per-keystroke fires don't hammer the parent / data
   * resource; column-scope changes fire immediately (no typing race).
   */
  onSearchChange: (next: { q: string; fieldIds: string[] }) => void;
};

/**
 * Free-text search input. Pure controlled component — owns its own
 * debounced typing buffer and emits committed values via
 * `onSearchChange`. Column-scope (which fields to search in) lives
 * inline as a compact multi-select on the right.
 */
export default function SearchBar(props: Props) {
  const locale = useLocale();
  const t = () => toolbarMessages.resolve([locale()]).t;
  const [q, setQ] = createSignal(props.initialQ);
  const [qFields, setQFields] = createSignal<string[]>(props.initialQFields);

  const debounce = timing.debounce((next: string, fields: string[]) => {
    props.onSearchChange({ q: next.trim(), fieldIds: fields });
  }, 250);

  createEffect(() => {
    debounce.cancel();
    setQ(props.initialQ);
    setQFields(props.initialQFields);
  });

  const onInput = (next: string) => {
    setQ(next);
    debounce.debouncedFn(next, qFields());
  };

  const onFieldsChange = (next: string[]) => {
    debounce.cancel();
    setQFields(next);
    props.onSearchChange({ q: q().trim(), fieldIds: next });
  };

  const allFieldsLabel = () => {
    if (qFields().length === 0) return t().searchAll;
    if (qFields().length === 1) {
      const f = props.fields.find((f) => f.id === qFields()[0]);
      return f?.name ?? t().oneColumn;
    }
    return t().columns({ count: qFields().length });
  };

  return (
    <div class="flex w-full min-w-0 flex-wrap gap-2">
      <div class="min-w-64 flex-[1_1_24rem]">
        <TextInput
          name="grids-record-search"
          type="search"
          aria-label={t().searchRecords}
          icon="ti ti-search"
          placeholder={t().searchRecordsPlaceholder}
          value={q}
          onValueChange={onInput}
          clearable
          onClear={() => {
            debounce.cancel();
            setQ("");
            props.onSearchChange({ q: "", fieldIds: qFields() });
          }}
        />
      </div>
      <Show when={props.fields.length > 0}>
        <div class="min-w-40 flex-[0_1_16rem]">
          <MultiSelectInput
            aria-label={t().searchColumns}
            icon="ti ti-columns"
            placeholder={allFieldsLabel()}
            value={qFields}
            onValueChange={onFieldsChange}
            options={props.fields.map((f) => ({
              id: f.id,
              label: f.name,
              icon: f.icon ?? "ti ti-columns",
              description: f.type,
              groups: fieldTypeGroups(f.type),
            }))}
            groups={fieldChoiceGroupsFor(props.fields, [], locale())}
            groupsAriaLabel={t().filterColumns}
            renderOption={(option) => (
              <span class="flex min-w-0 items-baseline gap-1.5">
                <strong class="truncate">{option.label}</strong>
                <small class="shrink-0 text-dimmed">{option.description}</small>
              </span>
            )}
            clearable
          />
        </div>
      </Show>
    </div>
  );
}
