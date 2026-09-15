import type { DateContext } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { createMemo, For, Show } from "solid-js";
import { FormulaConfigSchema } from "../../../field-types/formula";
import { type FormComputedField, planFormComputedFields, previewFormComputedFields } from "../../../form-computed-fields";
import type { FormConfig } from "../../../service/forms";
import { formatCell } from "../table/format-cell";
import { gridsFormMessages } from "./messages";
import { formFieldClass, formLayoutClass } from "./field-layout";

export function FormComputedSummary(props: {
  config: FormConfig;
  fields: FormComputedField[];
  values: Record<string, unknown>;
  dateConfig?: DateContext;
}) {
  const locale = useLocale();
  const t = () => gridsFormMessages.resolve([locale()]).t;
  const entries = () => props.config.computedFields ?? [];
  const plan = createMemo(() =>
    planFormComputedFields(
      entries().map((entry) => entry.fieldId),
      new Set(props.config.fields.filter((entry) => entry.kind === "user_input").map((entry) => entry.fieldId)),
      props.fields,
    ),
  );
  const hasEmptyList = () =>
    plan()?.fields.some((field) => {
      const value = props.values[field.id];
      return field.type === "object_list" && (value == null || (Array.isArray(value) && value.length === 0));
    });
  const result = createMemo(() =>
    previewFormComputedFields(
      entries().map((entry) => entry.fieldId),
      new Set(props.config.fields.filter((entry) => entry.kind === "user_input").map((entry) => entry.fieldId)),
      props.fields.map((field) => ({
        ...field,
        required:
          field.required ||
          props.config.fields.some((entry) => entry.kind === "user_input" && entry.fieldId === field.id && entry.required),
      })),
      props.values,
      { dateConfig: props.dateConfig, locale: locale() },
    ),
  );
  return (
    <Show when={entries().length && plan() && !hasEmptyList()}>
      <section
        class="flex w-full min-w-0 max-w-2xl flex-col gap-3 rounded-lg bg-input p-4"
        aria-label={t().computedSummary}
        aria-live="polite"
      >
        <h3 class="text-sm font-medium text-dimmed">{t().computedSummary}</h3>
        <dl class={formLayoutClass}>
          <For each={entries()}>
            {(entry) => {
              const field = () => props.fields.find((field) => field.id === entry.fieldId);
              return (
                <div class={`${formFieldClass(entry.width)} flex flex-col gap-1`}>
                  <dt class="min-w-0 break-words text-sm text-dimmed">
                    <span>{entry.label || field()?.name}</span>
                    <Show when={entry.helpText}>
                      <p class="text-sm text-dimmed">{entry.helpText}</p>
                    </Show>
                  </dt>
                  <dd class="min-h-6 min-w-0 break-words font-medium tabular-nums">
                    {(() => {
                      const schema = field();
                      const values = result();
                      if (!schema || values.kind !== "values") return <span class="sr-only">{t().calculationPending}</span>;
                      const config = FormulaConfigSchema.safeParse(schema.config);
                      return formatCell(
                        values.values[entry.fieldId],
                        schema.type,
                        config.success ? config.data : undefined,
                        config.success ? config.data.format : undefined,
                        props.dateConfig,
                        locale(),
                      );
                    })()}
                  </dd>
                </div>
              );
            }}
          </For>
        </dl>
        <Show when={result().kind !== "values" && result().kind !== "error"}>
          <p class="text-sm text-dimmed">{t().calculationPending}</p>
        </Show>
        <Show when={result().kind === "error"}>
          <p class="text-sm text-danger" role="status">
            {t().summaryError}
          </p>
        </Show>
      </section>
    </Show>
  );
}
