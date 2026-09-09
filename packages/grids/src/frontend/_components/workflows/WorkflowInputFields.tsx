import { DatePicker, DateTimePicker, MultiSelectInput, NoticeCard, NumberInput, Select, TextInput, useLocale } from "@k2b/ui";
import type { WorkflowBoundPlan, WorkflowIrInput } from "@k2b/cloud/workflows";
import { For, Match, Show, Switch } from "solid-js";
import type { PublicTable } from "../../../api/public-dto";
import RecordPicker from "../records/RecordPicker";
import { fetchRecordLookup } from "../records/record-lookup";
import { workflowMessages } from "./messages";
import {
  type WorkflowRunInputDraft,
  type WorkflowRunInputDraftValue,
  workflowInputDescription,
  workflowInputLabel,
  workflowInputOptions,
  workflowInputRequired,
} from "./workflow-trigger-actions";

type Props = {
  workflow: { plan: Pick<WorkflowBoundPlan, "inputs" | "bindings"> };
  tables: Array<Pick<PublicTable, "id" | "name">>;
  draft: () => WorkflowRunInputDraft;
  onValueChange: (name: string, value: WorkflowRunInputDraftValue) => void;
  errors?: () => Record<string, string>;
  emptyText?: string;
};

const resolveInputTable = (
  workflow: { plan: Pick<WorkflowBoundPlan, "bindings"> },
  input: WorkflowIrInput,
  tables: Array<Pick<PublicTable, "id" | "name">>,
): Pick<PublicTable, "id" | "name"> | null => {
  const bound = workflow.plan.bindings[`inputs.${input.name}.table`];
  const reference = (typeof bound === "string" ? bound : input.config.table)?.toString().trim().toLowerCase();
  if (!reference) return null;
  return tables.find((table) => [table.id, table.name].some((value) => value.toLowerCase() === reference)) ?? null;
};

export function WorkflowInputFields(props: Props) {
  const locale = useLocale();
  const t = () => workflowMessages.resolve([locale()]).t;
  const inputs = () => props.workflow.plan.inputs;
  const value = (name: string) => props.draft()[name];
  const errorFor = (name: string) => () => props.errors?.()[name];

  return (
    <div class="flex flex-col gap-3">
      <For each={inputs()}>
        {(input) => {
          const name = input.name;
          const label = workflowInputLabel(input);
          const description = workflowInputDescription(input);
          const required = workflowInputRequired(input);
          const table = resolveInputTable(props.workflow, input, props.tables);
          return (
            <Switch>
              <Match when={input.type === "record" && table}>
                <RecordPicker
                  tableId={table!.id}
                  label={label}
                  description={description}
                  placeholder={t().chooseRecord}
                  clearable={!required}
                  required={required}
                  error={errorFor(name)}
                  value={() => (typeof value(name) === "string" ? (value(name) as string) : "")}
                  onChange={(recordId) => props.onValueChange(name, recordId)}
                />
              </Match>
              <Match when={input.type === "recordList" && table}>
                <MultiSelectInput
                  label={label}
                  description={description}
                  placeholder={t().chooseRecords}
                  required={required}
                  clearable={!required}
                  error={errorFor(name)}
                  value={() => (Array.isArray(value(name)) ? (value(name) as string[]) : [])}
                  onValueChange={(recordIds) => props.onValueChange(name, recordIds)}
                  fetchData={async (query, signal) =>
                    (await fetchRecordLookup({ tableId: table!.id, query, signal, locale: locale() })).map((record) => ({
                      id: record.id,
                      label: record.label,
                      icon: "ti ti-database",
                    }))
                  }
                />
              </Match>
              <Match when={(input.type === "record" || input.type === "recordList") && !table}>
                <NoticeCard tone="danger" icon={false}>
                  {t().inputTableUnavailable({ label })}
                </NoticeCard>
              </Match>
              <Match when={input.type === "number"}>
                <NumberInput
                  label={label}
                  description={description}
                  required={required}
                  decimalPlaces={10}
                  value={() => (typeof value(name) === "number" ? (value(name) as number) : null)}
                  onValueChange={(next) => props.onValueChange(name, next)}
                  error={errorFor(name)}
                />
              </Match>
              <Match when={input.type === "boolean"}>
                <Select
                  label={label}
                  description={description}
                  required={required}
                  clearable={!required}
                  options={[
                    { id: "true", label: t().yes },
                    { id: "false", label: t().no },
                  ]}
                  value={() => (typeof value(name) === "boolean" ? String(value(name)) : "")}
                  onValueChange={(next) => props.onValueChange(name, next === "" ? undefined : next === "true")}
                  error={errorFor(name)}
                />
              </Match>
              <Match when={input.type === "date"}>
                <DatePicker
                  label={label}
                  description={description}
                  required={required}
                  clearable={!required}
                  value={() => (typeof value(name) === "string" ? (value(name) as string) : null)}
                  onValueChange={(next) => props.onValueChange(name, next)}
                  error={errorFor(name)}
                />
              </Match>
              <Match when={input.type === "dateTime"}>
                <DateTimePicker
                  label={label}
                  description={description}
                  required={required}
                  clearable={!required}
                  value={() => (typeof value(name) === "string" ? (value(name) as string) : null)}
                  onValueChange={(next) => props.onValueChange(name, next)}
                  error={errorFor(name)}
                />
              </Match>
              <Match when={input.type === "select"}>
                <Select
                  label={label}
                  description={description}
                  required={required}
                  clearable={!required}
                  options={workflowInputOptions(input)}
                  value={() => (typeof value(name) === "string" ? (value(name) as string) : "")}
                  onValueChange={(next) => props.onValueChange(name, next)}
                  error={errorFor(name)}
                />
              </Match>
              <Match when={input.type === "text"}>
                <TextInput
                  label={label}
                  description={description}
                  required={required}
                  clearable={!required}
                  value={() => (typeof value(name) === "string" ? (value(name) as string) : "")}
                  onValueChange={(next) => props.onValueChange(name, next)}
                  error={errorFor(name)}
                />
              </Match>
            </Switch>
          );
        }}
      </For>
      <Show when={inputs().length === 0}>
        <p class="text-sm text-dimmed">{props.emptyText ?? t().noInputRequired}</p>
      </Show>
    </div>
  );
}
