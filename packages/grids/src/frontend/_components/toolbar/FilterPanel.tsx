import type { DateContext } from "@k2b/stdlib";
import {
  Button,
  DatePicker,
  DateRangePicker,
  DateTimePicker,
  IconButton,
  MultiSelectInput,
  NumberInput,
  Select,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { EntitySearch, type EntitySearchPrincipal } from "@valentinkolb/cloud/account/ui";
import { createEffect, createMemo, createSignal, For, Index, Match, onMount, Switch, untrack } from "solid-js";
import type { PublicField as Field } from "../../../api/public-dto";
import { fieldChoiceGroupsFor, fieldOption } from "../fields/field-type-meta";
import RelationPicker from "../records/RelationPicker";
import { type FilterOp, filterableFields, localizedOpsForType, opsForType } from "./filter-ops";
import { toolbarMessages } from "./messages";

export type FilterLeaf = {
  fieldId: string;
  op: string;
  value?: unknown;
};

/**
 * Strict-controlled input. Three props, no apply / dirty / URL logic —
 * the surrounding GridToolbar (or any other parent) handles "commit
 * this state". The toolbar uses `isFilterLeafComplete` to filter out
 * partial rows when serialising the combined URL.
 */
type Props = {
  fields: Field[];
  rows: () => FilterLeaf[];
  onRowsChange: (next: FilterLeaf[]) => void;
  dateConfig?: DateContext;
};

/**
 * Predicate exported for callers that want to validate filter leaves
 * outside the panel — e.g. the GridToolbar's "Apply all" chip needs to
 * filter out incomplete rows before serialising the combined URL.
 */
export const isFilterLeafComplete = (leaf: FilterLeaf, fields: Field[]): boolean => {
  const field = fields.find((f) => f.id === leaf.fieldId);
  if (!field) return false;
  const op = opsForType(field.type).find((o) => o.id === leaf.op);
  if (!op) return false;
  if (!op.needsValue) return true;
  if (leaf.value === undefined || leaf.value === "" || leaf.value === null) return false;
  if (Array.isArray(leaf.value) && leaf.value.length === 0) return false;
  if (op.needsRange) {
    return Array.isArray(leaf.value) && leaf.value.length === 2 && leaf.value.every((v) => v !== "" && v != null);
  }
  return true;
};

/** Build a blank filter leaf for the first available field/op pair. */
export const blankLeaf = (fields: Field[]): FilterLeaf | null => {
  const usable = filterableFields(fields);
  const first = usable[0];
  if (!first) return null;
  const ops = opsForType(first.type);
  return { fieldId: first.id, op: ops[0]?.id ?? "", value: "" };
};

export default function FilterPanel(props: Props) {
  const locale = useLocale();
  const t = () => toolbarMessages.resolve([locale()]).t;
  const fields = createMemo(() => filterableFields(props.fields));

  const updateLeaf = (index: number, patch: Partial<FilterLeaf>) => {
    const next = props.rows().map((l, i) => (i === index ? { ...l, ...patch } : l));
    // Field change → reset op to first valid op for new type
    if (patch.fieldId !== undefined) {
      const field = props.fields.find((f) => f.id === patch.fieldId);
      if (field) {
        const ops = opsForType(field.type);
        next[index] = { ...next[index]!, op: ops[0]?.id ?? "", value: "" };
      }
    }
    props.onRowsChange(next);
  };

  const addLeaf = () => {
    const blank = blankLeaf(props.fields);
    if (blank) props.onRowsChange([...props.rows(), blank]);
  };
  const removeLeaf = (index: number) => props.onRowsChange(props.rows().filter((_, i) => i !== index));

  if (fields().length === 0) return null;

  return (
    <div class="flex flex-col gap-1.5">
      {/*
        Index (not For) so editing a row's value doesn't replace the
        outer row object → For would unmount the input mid-keystroke.
      */}
      <Index each={props.rows()}>
        {(leafSignal, index) => {
          const leaf = leafSignal;
          const field = createMemo(() => props.fields.find((f) => f.id === leaf().fieldId) ?? null);
          const ops = createMemo<FilterOp[]>(() => (field() ? localizedOpsForType(field()!.type, locale()) : []));
          const op = createMemo<FilterOp | null>(() => ops().find((o) => o.id === leaf().op) ?? null);

          return (
            <div class="flex flex-wrap items-center gap-1.5 text-xs">
              {/* Fixed-width label so all rows align: "where" (5 chars)
                  and "and" (3 chars) sit in the same column → the field
                  Select below stays vertically aligned across rows. */}
              <span class="w-12 shrink-0 text-dimmed">{index === 0 ? t().where : t().and}</span>
              <div class="w-64 shrink-0">
                <Select
                  aria-label={t().filterField({ index: index + 1 })}
                  value={() => leaf().fieldId}
                  onValueChange={(v) => {
                    if (v !== null) updateLeaf(index, { fieldId: v });
                  }}
                  options={fields().map((f) => fieldOption(f, t().field, locale()))}
                  groups={fieldChoiceGroupsFor(fields(), [], locale())}
                  groupsAriaLabel={t().filterFields}
                  placeholder={t().field}
                />
              </div>
              <div class="w-56 shrink-0">
                <Select
                  aria-label={t().filterOperator({ index: index + 1 })}
                  value={() => leaf().op}
                  onValueChange={(v) => {
                    if (v !== null) updateLeaf(index, { op: v, value: "" });
                  }}
                  options={ops().map((o) => ({ id: o.id, label: o.label, description: o.description, icon: o.icon }))}
                  placeholder={t().operator}
                />
              </div>

              <FilterValueInput
                field={field()}
                op={op()}
                value={leaf().value}
                onChange={(v) => updateLeaf(index, { value: v })}
                dateConfig={props.dateConfig}
              />

              <IconButton
                variant="ghost"
                size="xs"
                class="text-dimmed hover:text-red-500 px-1"
                onClick={() => removeLeaf(index)}
                label={t().removeFilter}
              >
                <i class="ti ti-x" />
              </IconButton>
            </div>
          );
        }}
      </Index>

      {/* Bottom row — Add only. Apply is owned by the GridToolbar's
          floating Apply/Cancel chips (one for the whole query state). */}
      <div class="flex items-center gap-1">
        <Button variant="success" size="sm" type="button" onClick={addLeaf}>
          <i class="ti ti-plus" /> {t().add}
        </Button>
      </div>
    </div>
  );
}

type ValueKind = "none" | "range" | "select" | "multi" | "boolean" | "relation" | "principal" | "number-days" | "date" | "number" | "text";

/**
 * Renders the right-hand value input for a filter row, type-aware:
 *  - ops with `needsValue=false` (empty, not empty, today, …): NOTHING
 *  - ops with `needsRange=true` (between): TWO inputs side-by-side
 *  - boolean fields: cloud Select
 *  - select fields (is / isNot): cloud Select over field options
 *  - select multi-value ops (one-of / none-of): MultiSelectInput
 *  - relation contains: RelationPicker over the target table
 *  - dates: cloud DatePicker / DateTimePicker (or NumberInput for lastNDays)
 *  - numeric fields: cloud NumberInput
 *  - text-shaped fallback: cloud TextInput
 *
 * IMPORTANT: this component is REACTIVE by way of Switch/Match — destructuring
 * `props.op` at the function body level captures a stale value and the input
 * fails to switch when the user picks a different operator (e.g. "empty" still
 * shows a text box). Always read `props.op` / `props.field` from inside JSX
 * or memos; never bind them to const at the top.
 */
function FilterValueInput(props: {
  field: Field | null;
  op: FilterOp | null;
  value: unknown;
  onChange: (v: unknown) => void;
  dateConfig?: DateContext;
}) {
  const locale = useLocale();
  const t = () => toolbarMessages.resolve([locale()]).t;
  const kind = createMemo<ValueKind>(() => {
    const field = props.field;
    const op = props.op;
    if (!field || !op || !op.needsValue) return "none";
    if (op.needsRange) return "range";
    if (field.type === "select" && (op.id === "is" || op.id === "isNot")) {
      return "select";
    }
    if (op.id === "isAnyOf" || op.id === "isNoneOf") {
      return "multi";
    }
    if (field.type === "boolean") return "boolean";
    if (field.type === "relation" && op.id === "containsAny") return "relation";
    if (field.type === "principal") return "principal";
    if (field.type === "date" && op.id === "lastNDays") return "number-days";
    if (field.type === "date") return "date";
    if (field.type === "number" || field.type === "percent" || field.type === "duration") {
      return "number";
    }
    return "text";
  });

  return (
    <Switch>
      {/* "none" → render nothing; covered by Switch's no-match fallback. */}

      <Match when={kind() === "range"}>
        {(() => {
          const range = () => (Array.isArray(props.value) ? (props.value as [unknown, unknown]) : ["", ""]);
          const isDate = () => props.field?.type === "date";
          const includeTime = () => Boolean((props.field?.config as { includeTime?: boolean } | undefined)?.includeTime);
          const numAt = (i: 0 | 1) => {
            const v = range()[i];
            const n = typeof v === "number" ? v : Number(v);
            return Number.isFinite(n) ? n : null;
          };
          const dateAt = (i: 0 | 1) => {
            const v = range()[i];
            return typeof v === "string" ? v : "";
          };
          return (
            <span class="flex items-center gap-1">
              {isDate() ? (
                <div class="w-96">
                  <DateRangePicker
                    aria-label={t().filterDateRange}
                    withTime={includeTime()}
                    dateConfig={props.dateConfig}
                    value={() => ({ start: dateAt(0) || null, end: dateAt(1) || null })}
                    onValueChange={(v) => props.onChange([v.start ?? "", v.end ?? ""])}
                    clearable
                  />
                </div>
              ) : (
                <>
                  <div class="w-52">
                    <NumberInput
                      aria-label={t().filterRangeStart}
                      value={() => numAt(0)}
                      onValueChange={(v) => props.onChange([v, range()[1]])}
                      decimalPlaces={10}
                    />
                  </div>
                  <span class="text-dimmed">{t().to}</span>
                  <div class="w-52">
                    <NumberInput
                      aria-label={t().filterRangeEnd}
                      value={() => numAt(1)}
                      onValueChange={(v) => props.onChange([range()[0], v])}
                      decimalPlaces={10}
                    />
                  </div>
                </>
              )}
            </span>
          );
        })()}
      </Match>

      <Match when={kind() === "select"}>
        <div class="w-80">
          <Select
            aria-label={t().filterValue}
            value={() => (typeof props.value === "string" ? props.value : "")}
            onValueChange={(v) => props.onChange(v)}
            options={(
              (props.field?.config as { options?: Array<{ id: string; label: string; description?: string; icon?: string }> } | undefined)
                ?.options ?? []
            ).map((o) => ({ id: o.id, label: o.label, description: o.description, icon: o.icon }))}
            placeholder="—"
          />
        </div>
      </Match>

      <Match when={kind() === "multi"}>
        <div class="w-96">
          <MultiSelectInput
            aria-label={t().filterValues}
            placeholder={t().options}
            value={() => (Array.isArray(props.value) ? props.value.filter((item): item is string => typeof item === "string") : [])}
            onValueChange={(value) => props.onChange(value)}
            options={(
              (
                props.field?.config as
                  | { options?: Array<{ id: string; label: string; description?: string; icon?: string; color?: string }> }
                  | undefined
              )?.options ?? []
            ).map((option) => ({
              id: option.id,
              label: option.label,
              description: option.description,
              icon: option.icon,
              color: option.color,
            }))}
            clearable
          />
        </div>
      </Match>

      <Match when={kind() === "boolean"}>
        <div class="w-44">
          <Select
            aria-label={t().filterBoolean}
            value={() => (props.value === true ? "true" : props.value === false ? "false" : "")}
            onValueChange={(v) => props.onChange(v === "" ? "" : v === "true")}
            options={[
              { id: "true", label: t().trueLabel, description: t().checkedDescription, icon: "ti ti-check" },
              { id: "false", label: t().falseLabel, description: t().uncheckedDescription, icon: "ti ti-x" },
            ]}
            placeholder="—"
            clearable
          />
        </div>
      </Match>

      <Match when={kind() === "relation"}>
        <div class="w-80">
          {(() => {
            const targetTableId = (props.field?.config as { targetTableId?: string } | undefined)?.targetTableId;
            if (!targetTableId) return <span class="text-xs text-amber-600 dark:text-amber-400">{t().pickTargetTable}</span>;
            return (
              <RelationPicker
                targetTableId={targetTableId}
                value={() => (Array.isArray(props.value) ? (props.value as string[]) : [])}
                labels={() => ({})}
                multi
                onChange={(v) => props.onChange(v)}
              />
            );
          })()}
        </div>
      </Match>

      <Match when={kind() === "principal"}>
        <PrincipalFilterInput value={props.value} onChange={props.onChange} />
      </Match>

      <Match when={kind() === "number-days"}>
        <div class="w-56">
          <NumberInput
            aria-label={t().filterDays}
            min={1}
            placeholder={t().days}
            value={() => {
              const v = props.value;
              const n = typeof v === "number" ? v : Number(v);
              return Number.isFinite(n) ? n : null;
            }}
            onValueChange={(v) => props.onChange(v)}
          />
        </div>
      </Match>

      <Match when={kind() === "date"}>
        <div class="w-80">
          {(() => {
            const includeTime = () => Boolean((props.field?.config as { includeTime?: boolean } | undefined)?.includeTime);
            const value = () => (typeof props.value === "string" && props.value ? props.value : null);
            const onChange = (v: string | null) => props.onChange(v ?? "");
            return includeTime() ? (
              <DateTimePicker
                aria-label={t().filterDateTime}
                dateConfig={props.dateConfig}
                value={value}
                onValueChange={onChange}
                clearable
              />
            ) : (
              <DatePicker aria-label={t().filterDate} dateConfig={props.dateConfig} value={value} onValueChange={onChange} clearable />
            );
          })()}
        </div>
      </Match>

      <Match when={kind() === "number"}>
        <div class="w-56">
          <NumberInput
            aria-label={t().filterNumber}
            value={() => {
              const v = props.value;
              const n = typeof v === "number" ? v : Number(v);
              return Number.isFinite(n) ? n : null;
            }}
            onValueChange={(v) => props.onChange(v)}
            decimalPlaces={10}
          />
        </div>
      </Match>

      <Match when={kind() === "text"}>
        <div class="w-80">
          <TextInput
            aria-label={t().filterValue}
            value={() => (typeof props.value === "string" ? props.value : "")}
            onValueChange={(v) => props.onChange(v)}
          />
        </div>
      </Match>
    </Switch>
  );
}

type PrincipalFilterOption = { id: string; type: "user" | "group"; label: string };

function PrincipalFilterInput(props: { value: unknown; onChange: (value: unknown) => void }) {
  const locale = useLocale();
  const t = () => toolbarMessages.resolve([locale()]).t;
  const ids = () => (Array.isArray(props.value) ? props.value.filter((item): item is string => typeof item === "string") : []);
  const [options, setOptions] = createSignal<PrincipalFilterOption[]>([]);

  createEffect(() => {
    const nextIds = ids();
    const current = new Map(untrack(options).map((option) => [option.id, option]));
    setOptions(nextIds.map((id) => current.get(id) ?? { id, type: "user", label: t().selectedIdentity }));
  });

  onMount(async () => {
    const initialIds = ids();
    if (initialIds.length === 0) return;
    const url = new URL("/api/accounts/entities", window.location.origin);
    url.searchParams.set("kinds", "user,group");
    url.searchParams.set("user_ids", initialIds.join(","));
    url.searchParams.set("group_ids", initialIds.join(","));
    url.searchParams.set("per_page", String(Math.min(100, initialIds.length * 2)));
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok) return;
    const body = (await response.json()) as {
      items?: Array<{
        kind: "user" | "group";
        user?: { id: string; uid: string; displayName: string };
        group?: { id: string; name: string };
      }>;
    };
    const resolved = new Map<string, PrincipalFilterOption>();
    for (const item of body.items ?? []) {
      if (item.kind === "user" && item.user) {
        resolved.set(item.user.id, { id: item.user.id, type: "user", label: item.user.displayName || item.user.uid });
      }
      if (item.kind === "group" && item.group) {
        resolved.set(item.group.id, { id: item.group.id, type: "group", label: item.group.name });
      }
    }
    setOptions((current) => current.map((option) => resolved.get(option.id) ?? option));
  });

  const add = (principal: EntitySearchPrincipal) => {
    const option: PrincipalFilterOption | null =
      principal.type === "user"
        ? { id: principal.userId, type: "user", label: principal.displayName || principal.uid }
        : principal.type === "group"
          ? { id: principal.groupId, type: "group", label: principal.name }
          : null;
    if (!option) return;
    const next = [...options().filter((item) => item.id !== option.id), option];
    setOptions(next);
    props.onChange(next.map((item) => item.id));
  };

  const remove = (id: string) => {
    const next = options().filter((item) => item.id !== id);
    setOptions(next);
    props.onChange(next.map((item) => item.id));
  };

  return (
    <div class="w-96">
      <div class="flex flex-col gap-1.5">
        <For each={options()}>
          {(option) => (
            <div class="flex items-center gap-2 rounded-md bg-[var(--ui-surface-subtle)] px-2 py-1.5">
              <i class={`ti ${option.type === "user" ? "ti-user" : "ti-users-group"} text-dimmed`} aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate text-sm">{option.label}</span>
              <IconButton size="xs" variant="ghost" label={t().removeIdentity({ name: option.label })} onClick={() => remove(option.id)}>
                <i class="ti ti-x" aria-hidden="true" />
              </IconButton>
            </div>
          )}
        </For>
        <EntitySearch
          includeUsers
          includeGroups
          excludeUserIds={ids()}
          excludeGroupIds={ids()}
          placeholder={t().searchUsersGroups}
          resultsHeightClass="max-h-48"
          onSelect={add}
        />
      </div>
    </div>
  );
}
