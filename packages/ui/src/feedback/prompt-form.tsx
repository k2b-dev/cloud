import { For, type JSX, Show } from "solid-js";
import { Checkbox } from "../inputs/Checkbox";
import { PinInput } from "../inputs/ChoiceInputs";
import { DatePicker, DateTimePicker } from "../inputs/DatePicker";
import { ImageInput } from "../inputs/FileInputs";
import { NumberInput } from "../inputs/NumberInput";
import { Select } from "../inputs/Select";
import { TagsInput } from "../inputs/TagsInput";
import { TextInput } from "../inputs/TextInput";
import { resolveUiMessages } from "../intl/messages";
import { DialogHeader, promptButtonVariant, promptTone } from "./prompt-confirm";
import { createFormState, type FieldSchema, type InferFormValues, type PromptFormOptions, type PromptFormValue } from "./prompts";

/**
 * The form of `prompts.form`, `prompts.prompt` and `prompts.promptNumber` with its field components. It loads on demand,
 * so an island that only confirms does not carry the date picker, the Markdown editor and the other fields.
 */
const renderInfo = (content: Extract<FieldSchema, { type: "info" }>["content"]): JSX.Element => {
  if (typeof content === "string") return <p>{content}</p>;
  if (typeof content === "function") return content();
  return content;
};

const PromptControl = (props: {
  field: Exclude<FieldSchema, { type: "info" }>;
  value: () => PromptFormValue;
  update: (value: PromptFormValue) => void;
  error: () => string | undefined;
  submit: () => void;
}): JSX.Element => {
  const label = props.field.label || undefined;

  switch (props.field.type) {
    case "text":
      return (
        <TextInput
          label={label}
          description={props.field.description}
          required={props.field.required}
          placeholder={props.field.placeholder}
          error={props.error}
          value={String(props.value() ?? "")}
          onValueChange={(value) => props.update(value ?? undefined)}
          onSubmit={props.submit}
          multiline={props.field.multiline}
          lines={props.field.lines}
          icon={props.field.icon}
          activeIcon={props.field.activeIcon}
          password={props.field.password}
          markdown={props.field.markdown}
          minLength={props.field.minLength}
          maxLength={props.field.maxLength}
        />
      );
    case "number":
      return (
        <NumberInput
          label={label}
          description={props.field.description}
          required={props.field.required}
          placeholder={props.field.placeholder}
          error={props.error}
          value={typeof props.value() === "number" ? (props.value() as number) : null}
          onValueChange={(value) => props.update(value ?? undefined)}
          min={props.field.min}
          max={props.field.max}
          step={props.field.step}
        />
      );
    case "image":
      return (
        <ImageInput
          label={label}
          description={props.field.description}
          required={props.field.required}
          error={props.error}
          value={() => (typeof props.value() === "string" ? (props.value() as string) : null)}
          onValueChange={(value) => props.update(value ?? undefined)}
          round={props.field.round}
          aria-label={props.field.ariaLabel}
          accept={props.field.accept}
        />
      );
    case "pin":
      return (
        <PinInput
          label={label}
          description={props.field.description}
          required={props.field.required}
          error={props.error}
          value={() => String(props.value() ?? "")}
          onValueChange={props.update}
          length={props.field.length}
          stretch={props.field.stretch}
        />
      );
    case "select":
      return (
        <Select
          label={label}
          description={props.field.description}
          required={props.field.required}
          placeholder={props.field.placeholder}
          error={props.error}
          value={() => (typeof props.value() === "string" ? (props.value() as string) : null)}
          onValueChange={(value) => props.update(value ?? undefined)}
          options={props.field.options}
          icon={props.field.icon}
          activeIcon={props.field.activeIcon}
          clearable={props.field.clearable}
        />
      );
    case "tags":
      return (
        <TagsInput
          label={label}
          description={props.field.description}
          required={props.field.required}
          placeholder={props.field.placeholder}
          error={props.error}
          value={() => (Array.isArray(props.value()) ? (props.value() as string[]) : [])}
          onValueChange={props.update}
          maxTags={props.field.maxTags}
          icon={props.field.icon}
          activeIcon={props.field.activeIcon}
        />
      );
    case "boolean":
      return (
        <Checkbox
          label={label}
          description={props.field.description}
          required={props.field.required}
          error={props.error}
          value={() => Boolean(props.value())}
          onValueChange={props.update}
        />
      );
    case "datetime": {
      const pickerProps = {
        label,
        description: props.field.description,
        required: props.field.required,
        placeholder: props.field.placeholder,
        error: props.error,
        value: () => (typeof props.value() === "string" ? (props.value() as string) : null),
        onValueChange: (value: string | null) => props.update(value ?? ""),
        clearable: true,
      };
      return props.field.dateOnly ? (
        <DatePicker {...pickerProps} />
      ) : (
        <DateTimePicker {...pickerProps} optionalTime={props.field.optionalTime} />
      );
    }
  }
};

export const PromptFormDialog = <T extends Record<string, FieldSchema>>(props: {
  config: PromptFormOptions<T>;
  close: (value: InferFormValues<T> | null) => void;
}): JSX.Element => {
  const state = createFormState(props.config.fields);
  const submit = () => {
    if (state.validateAll()) props.close(state.values as InferFormValues<T>);
  };
  const handleSubmit = (event: SubmitEvent) => {
    event.preventDefault();
    submit();
  };

  return (
    <form class="k2b-dialog__panel" onSubmit={handleSubmit}>
      <DialogHeader
        title={props.config.title}
        icon={props.config.icon}
        tone={promptTone(props.config.variant)}
        close={() => props.close(null)}
      />
      <div class="k2b-dialog__body k2b-prompt-form">
        <For each={Object.entries(props.config.fields)}>
          {([key, field]) => {
            if (field.type === "info") return <div class="k2b-prompt-form__info">{renderInfo(field.content)}</div>;
            return (
              <PromptControl
                field={field}
                value={() => state.values[key]}
                update={(value) => state.updateField(key, value)}
                error={() => state.errors[key]}
                submit={submit}
              />
            );
          }}
        </For>
      </div>
      <footer class="k2b-dialog__actions">
        <Show when={props.config.cancelText !== false}>
          <button type="button" class="k2b-button" data-variant="secondary" onClick={() => props.close(null)}>
            {props.config.cancelText || resolveUiMessages().cancel}
          </button>
        </Show>
        <button type="submit" class="k2b-button" data-variant={promptButtonVariant(props.config.variant)}>
          {props.config.confirmText ?? resolveUiMessages().save}
        </button>
      </footer>
    </form>
  );
};
