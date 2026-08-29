import { Button, IconButton, Select, TextInput, useLocale } from "@k2b/ui";
import { For, Show } from "solid-js";
import type { PublicField as Field } from "../../../api/public-dto";
import type { FormValidationRule } from "../../../contracts";
import { formValidationComparableKind, formValidationFieldsCompatible } from "../../../form-validations";
import type { FormFieldEntry } from "../../../service/forms";
import { gridsFormMessages } from "./messages";

const OPERATOR_IDS: FormValidationRule["operator"][] = ["lte", "lt", "gte", "gt", "eq", "neq"];
const isOperator = (value: string): value is FormValidationRule["operator"] => OPERATOR_IDS.some((operator) => operator === value);

export function FormValidationsEditor(props: {
  fields: Field[];
  entries: FormFieldEntry[];
  rules: FormValidationRule[];
  onChange: (rules: FormValidationRule[]) => void;
}) {
  const locale = useLocale();
  const t = () => gridsFormMessages.resolve([locale()]).t;
  const operators = () => [
    { id: "lte" as const, label: t().operatorLte },
    { id: "lt" as const, label: t().operatorLt },
    { id: "gte" as const, label: t().operatorGte },
    { id: "gt" as const, label: t().operatorGt },
    { id: "eq" as const, label: t().operatorEq },
    { id: "neq" as const, label: t().operatorNeq },
  ];
  const fieldsById = () => new Map(props.fields.map((field) => [field.id, field]));
  const comparableFields = () => {
    const visibleIds = new Set(props.entries.filter((entry) => entry.kind === "user_input").map((entry) => entry.fieldId));
    return props.fields.filter((field) => visibleIds.has(field.id) && !field.deletedAt && formValidationComparableKind(field));
  };
  const options = () => comparableFields().map((field) => ({ id: field.id, label: field.name }));
  const compatibleOptions = (fieldId: string) => {
    const left = fieldsById().get(fieldId);
    return left ? comparableFields().filter((field) => field.id !== fieldId && formValidationFieldsCompatible(left, field)) : [];
  };
  const update = (index: number, patch: Partial<FormValidationRule>) =>
    props.onChange(props.rules.map((rule, current) => (current === index ? { ...rule, ...patch } : rule)));
  const add = () => {
    const [left, right] = comparableFields();
    if (!left) return;
    const compatible = right && formValidationFieldsCompatible(left, right) ? right : compatibleOptions(left.id)[0];
    if (!compatible) return;
    props.onChange([
      ...props.rules,
      {
        leftFieldId: left.id,
        operator: "lte",
        rightFieldId: compatible.id,
        message: t().defaultValidation({ left: left.name, right: compatible.name }),
        errorFieldId: left.id,
      },
    ]);
  };

  return (
    <div class="flex flex-col gap-3">
      <Show when={props.rules.length > 0} fallback={<p class="text-sm text-dimmed">{t().noValidations}</p>}>
        <For each={props.rules}>
          {(rule, index) => (
            <div class="paper grid grid-cols-1 gap-2 p-3 md:grid-cols-[1fr_1fr_1fr_1fr_auto]">
              <Select
                label={t().leftField}
                value={() => rule.leftFieldId}
                options={options()}
                onValueChange={(leftFieldId) => {
                  if (!leftFieldId) return;
                  const compatible = compatibleOptions(leftFieldId);
                  const rightFieldId = compatible.some((field) => field.id === rule.rightFieldId)
                    ? rule.rightFieldId
                    : (compatible[0]?.id ?? rule.rightFieldId);
                  update(index(), {
                    leftFieldId,
                    rightFieldId,
                    errorFieldId: rule.errorFieldId === rule.rightFieldId ? rightFieldId : leftFieldId,
                  });
                }}
              />
              <Select
                label={t().rule}
                value={() => rule.operator}
                options={operators()}
                onValueChange={(operator) => {
                  if (operator && isOperator(operator)) update(index(), { operator });
                }}
              />
              <Select
                label={t().rightField}
                value={() => rule.rightFieldId}
                options={compatibleOptions(rule.leftFieldId).map((field) => ({ id: field.id, label: field.name }))}
                onValueChange={(rightFieldId) => {
                  if (rightFieldId)
                    update(index(), {
                      rightFieldId,
                      errorFieldId: rule.errorFieldId === rule.rightFieldId ? rightFieldId : rule.errorFieldId,
                    });
                }}
              />
              <Select
                label={t().showErrorOn}
                value={() => rule.errorFieldId ?? rule.leftFieldId}
                options={[rule.leftFieldId, rule.rightFieldId].flatMap((fieldId) => {
                  const field = fieldsById().get(fieldId);
                  return field ? [{ id: field.id, label: field.name }] : [];
                })}
                onValueChange={(errorFieldId) => {
                  if (errorFieldId) update(index(), { errorFieldId });
                }}
              />
              <IconButton
                class="self-end text-red-500 hover:text-red-600"
                type="button"
                variant="ghost"
                label={t().removeValidation}
                onClick={() => props.onChange(props.rules.filter((_, current) => current !== index()))}
              >
                <i class="ti ti-trash" aria-hidden="true" />
              </IconButton>
              <TextInput
                class="md:col-span-5"
                label={t().validationMessage}
                value={() => rule.message}
                onValueChange={(message) => update(index(), { message })}
                required
              />
            </div>
          )}
        </For>
      </Show>
      <div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={add}
          disabled={props.rules.length >= 20 || comparableFields().length < 2}
        >
          <i class="ti ti-plus" aria-hidden="true" /> {t().addValidation}
        </Button>
      </div>
    </div>
  );
}
