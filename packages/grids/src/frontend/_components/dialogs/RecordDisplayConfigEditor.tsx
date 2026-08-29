import { MultiSelectInput, NoticeCard, Select, useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import type { PublicField as Field } from "../../../api/public-dto";
import type { RecordDisplayConfig, RecordDisplayMode } from "../../../contracts";
import { fieldOption, fieldTypeIcon, fieldTypeLabel } from "../fields/field-type-meta";
import { gridsDialogMessages } from "./messages";

const MODE_OPTIONS = [
  {
    id: "table",
    label: "Table",
    description: "Dense rows and columns.",
    icon: "ti ti-table",
  },
  {
    id: "cards",
    label: "Cards",
    description: "Visual record cards.",
    icon: "ti ti-layout-grid",
  },
  {
    id: "calendar",
    label: "Calendar",
    description: "Records placed by date.",
    icon: "ti ti-calendar",
  },
];

const withDefaults = (value: RecordDisplayConfig): RecordDisplayConfig => ({
  mode: value.mode ?? "table",
  cards: value.cards ?? {},
  calendar: value.calendar ?? {},
});

export function RecordDisplayConfigEditor(props: {
  value: () => RecordDisplayConfig;
  onChange: (value: RecordDisplayConfig) => void;
  fields: () => Field[];
}) {
  const locale = useLocale();
  const t = () => gridsDialogMessages.resolve([locale()]).t;
  const modeOptions = () =>
    MODE_OPTIONS.map((option) => ({
      ...option,
      label: option.id === "table" ? t().table : option.id === "cards" ? t().cards : t().calendar,
      description: option.id === "table" ? t().tableDescription : option.id === "cards" ? t().cardsDescription : t().calendarDescription,
    }));
  const display = () => withDefaults(props.value());
  const liveFields = () => props.fields().filter((field) => !field.deletedAt);
  const cardFieldOptions = () =>
    liveFields()
      .filter((field) => field.type !== "file")
      .map((field) => fieldOption(field, t().cardFieldDescription, locale()));
  const cardSelectedOptions = () => {
    const byId = new Map(cardFieldOptions().map((option) => [option.id, option]));
    return (display().cards?.fieldIds ?? []).flatMap((id) => {
      const option = byId.get(id);
      return option ? [option] : [];
    });
  };
  const imageFieldOptions = () =>
    liveFields()
      .filter((field) => field.type === "file")
      .map((field) => ({
        id: field.id,
        label: field.name,
        description: t().firstImageCover,
        icon: fieldTypeIcon(field.type, field.icon),
      }));
  const imageFieldLabel = () => {
    const fieldId = display().cards?.imageFieldId;
    return fieldId ? liveFields().find((field) => field.id === fieldId)?.name : undefined;
  };
  const dateFieldOptions = () =>
    liveFields()
      .filter((field) => field.type === "date")
      .map((field) => ({
        id: field.id,
        label: field.name,
        description: `${fieldTypeLabel(field.type, locale())} · ${t().eventDate}`,
        icon: fieldTypeIcon(field.type, field.icon),
      }));
  const dateFieldLabel = () => {
    const fieldId = display().calendar?.dateFieldId;
    return fieldId ? liveFields().find((field) => field.id === fieldId)?.name : undefined;
  };

  const patch = (next: Partial<RecordDisplayConfig>) => props.onChange({ ...display(), ...next });
  const patchCards = (cards: NonNullable<RecordDisplayConfig["cards"]>) => patch({ cards: { ...display().cards, ...cards } });
  const patchCalendar = (calendar: NonNullable<RecordDisplayConfig["calendar"]>) =>
    patch({ calendar: { ...display().calendar, ...calendar } });
  const changeMode = (mode: RecordDisplayMode) => {
    if (mode === "calendar" && !display().calendar?.dateFieldId) {
      patch({ mode, calendar: { ...display().calendar, dateFieldId: dateFieldOptions()[0]?.id ?? null } });
      return;
    }
    patch({ mode });
  };

  return (
    <div class="flex flex-col gap-4">
      <Select
        label={t().display}
        description={t().displayDescription}
        value={() => display().mode}
        onValueChange={(mode) => changeMode(mode as RecordDisplayMode)}
        options={modeOptions()}
      />

      <Show when={display().mode === "cards"}>
        <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Select
            label={t().coverImage}
            description={t().coverImageDescription}
            placeholder={imageFieldOptions().length > 0 ? t().noCoverImage : t().noFileFields}
            value={() => display().cards?.imageFieldId ?? ""}
            onValueChange={(imageFieldId) => patchCards({ imageFieldId: imageFieldId || null })}
            selectedLabel={imageFieldLabel}
            options={imageFieldOptions()}
            clearable
            disabled={imageFieldOptions().length === 0}
          />
          <MultiSelectInput
            label={t().cardFields}
            description={t().cardFieldsDescription}
            placeholder={t().chooseFields}
            icon="ti ti-layout-list"
            value={() => display().cards?.fieldIds ?? []}
            onValueChange={(fieldIds) => patchCards({ fieldIds })}
            options={cardFieldOptions()}
            selectedOptions={cardSelectedOptions}
            clearable
          />
        </div>
        <p class="text-xs text-dimmed">{t().cardsPermissions}</p>
      </Show>

      <Show when={display().mode === "calendar"}>
        <Select
          label={t().dateField}
          description={t().dateFieldDescription}
          placeholder={dateFieldOptions().length > 0 ? t().chooseDateField : t().noDateFields}
          value={() => display().calendar?.dateFieldId ?? ""}
          onValueChange={(dateFieldId) => patchCalendar({ dateFieldId: dateFieldId || null })}
          selectedLabel={dateFieldLabel}
          options={dateFieldOptions()}
          clearable
          disabled={dateFieldOptions().length === 0}
        />
        <Show when={dateFieldOptions().length === 0}>
          <NoticeCard tone="warning" icon={false}>
            {t().addDateField}
          </NoticeCard>
        </Show>
      </Show>
    </div>
  );
}
