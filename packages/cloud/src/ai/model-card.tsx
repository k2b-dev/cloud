import { ChoiceSlider, IconButton, useLocale } from "@k2b/ui";
import { createSignal, type JSX, Show } from "solid-js";
import { AI_MODEL_CLASSES, type AiModelClass, type AiPeopleModelIcon } from "../shared/ai-models";
import { aiModelChooserMessages } from "./model-chooser-messages";
import { AiModelIcon } from "./model-icon";

export type AiModelCardStop = {
  class: AiModelClass;
  /** The model behind the class, as people see it: short name and icon. */
  name: string;
  icon: AiPeopleModelIcon;
  /** Why the class cannot be chosen now; replaces the subtitle in the line. */
  unavailable?: string;
};

const asClass = (value: string | null): AiModelClass | null => AI_MODEL_CLASSES.find((modelClass) => modelClass === value) ?? null;

export const aiModelClassLabel = (locale: string, modelClass: AiModelClass): string =>
  aiModelChooserMessages.resolve([locale]).t[`class_${modelClass}`];
export const aiModelClassSubtitle = (locale: string, modelClass: AiModelClass): string =>
  aiModelChooserMessages.resolve([locale]).t[`classSub_${modelClass}`];

/**
 * The model card: the class in accent colour, the model behind it, one fixed line that always says what the class
 * is for, and the slider over the assigned classes. Off the classes it shows "Own choice" with the model's name.
 * The preview in the AI area renders the same card without interaction.
 */
export function AiModelCard(props: {
  stops: readonly AiModelCardStop[];
  /** The chosen class, or `null` for a model outside the classes. */
  value: AiModelClass | null;
  /** The model shown off the classes: "Name · Variant", its icon and its subtitle. */
  own?: { name: string; icon: AiPeopleModelIcon; description: string };
  /** A problem with the current model, such as a used-up budget; shown in warning colour. */
  issue?: string;
  /** Replaces the subtitle when the chosen class is empty and another one answers. */
  note?: string;
  onChoose?: (modelClass: AiModelClass) => void;
  onOpenList?: () => void;
  disabled?: boolean;
  /** A static preview: same layout, no controls. */
  preview?: boolean;
  size?: "md" | "lg";
  /** The slider's id, so the opener can move focus to it. */
  sliderId?: string;
}): JSX.Element {
  const locale = useLocale();
  const t = () => aiModelChooserMessages.resolve([locale()]).t;
  const [active, setActive] = createSignal<AiModelClass | null>(null);
  const shownClass = () => active() ?? props.value;
  const stop = () => props.stops.find((entry) => entry.class === shownClass());
  const level = () => (shownClass() ? aiModelClassLabel(locale(), shownClass()!) : t().ownChoice);
  const name = () => stop()?.name ?? props.own?.name ?? "";
  const icon = () => stop()?.icon ?? props.own?.icon;
  const warn = () => Boolean(props.issue) && active() === null;
  const options = () =>
    props.stops.map((entry) => ({
      value: entry.class,
      label: aiModelClassLabel(locale(), entry.class),
      description:
        entry.class === props.value && props.note && active() === null ? props.note : aiModelClassSubtitle(locale(), entry.class),
      disabledReason: entry.unavailable,
      valueText: [
        aiModelClassLabel(locale(), entry.class),
        entry.name,
        entry.unavailable ?? aiModelClassSubtitle(locale(), entry.class),
      ].join(", "),
    }));
  const atDefault = () => props.value === "balanced" || !props.stops.some((entry) => entry.class === "balanced");
  return (
    <div class="grid gap-0.5" data-ai-model-card={props.preview ? "preview" : ""} aria-hidden={props.preview ? "true" : undefined}>
      <div class="grid grid-cols-[2rem_minmax(0,1fr)_2rem] items-center">
        <i class="ti ti-gauge grid place-items-center text-(--k2b-text-muted)" aria-hidden="true" />
        <span
          class="truncate text-center text-[1.0625rem] leading-snug font-semibold tracking-tight"
          classList={{ "text-(--k2b-action)": !warn(), "text-(--k2b-warning-text)": warn() }}
        >
          {level()}
        </span>
        <span class="grid place-items-center" classList={{ invisible: atDefault() || props.preview || props.disabled }}>
          <IconButton
            type="button"
            variant="ghost"
            size="sm"
            label={t().resetTo}
            tabIndex={atDefault() || props.preview ? -1 : undefined}
            onClick={() => props.onChoose?.("balanced")}
          >
            <i class="ti ti-arrow-back-up" aria-hidden="true" />
          </IconButton>
        </span>
      </div>
      <div class="flex justify-center">
        <Show
          when={props.onOpenList && !props.preview}
          fallback={
            <span class="inline-flex max-w-full items-center gap-1.5 px-1.5 py-0.5 text-sm text-(--k2b-text-secondary)">
              <Show when={icon()}>{(current) => <AiModelIcon icon={current()} size="xs" />}</Show>
              <span class="truncate">{name()}</span>
            </span>
          }
        >
          <button
            type="button"
            class="inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-sm text-(--k2b-text-secondary) hover:bg-(--k2b-surface-muted) hover:text-(--k2b-text) focus-visible:outline-2 focus-visible:outline-(--k2b-focus-ring)"
            aria-label={`${t().allModels}: ${name()}`}
            disabled={props.disabled}
            onClick={() => props.onOpenList?.()}
          >
            <Show when={icon()}>{(current) => <AiModelIcon icon={current()} size="xs" />}</Show>
            <span class="truncate">{name()}</span>
            <i class="ti ti-chevron-right text-xs" aria-hidden="true" />
          </button>
        </Show>
      </div>
      <div>
        <ChoiceSlider
          id={props.sliderId}
          aria-label={t().sliderAria}
          options={options()}
          value={() => props.value}
          description={props.issue ?? props.own?.description}
          disabled={props.disabled || props.preview}
          size={props.size}
          onActiveChange={(value) => setActive(asClass(value))}
          onValueChange={(value) => {
            const modelClass = asClass(value);
            if (modelClass) props.onChoose?.(modelClass);
          }}
        />
      </div>
    </div>
  );
}
