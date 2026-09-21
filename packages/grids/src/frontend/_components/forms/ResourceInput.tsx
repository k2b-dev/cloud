import { openCloudResourcePicker } from "@k2b/cloud/browser/resource-picker";
import { Button, prompts, TextInput, useLocale } from "@k2b/ui";
import { createSignal } from "solid-js";
import { ResourceValueSchema } from "../../../field-types/resource";
import { gridsFormMessages } from "./messages";

export default function ResourceInput(props: {
  name: string;
  label: string;
  description?: string;
  required?: boolean;
  error?: () => string | undefined;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const locale = useLocale();
  const t = () => gridsFormMessages.resolve([locale()]).t;
  const [busy, setBusy] = createSignal(false);
  const value = () => {
    const parsed = ResourceValueSchema.safeParse(props.value);
    return parsed.success ? parsed.data : null;
  };
  const choose = async () => {
    if (busy()) return;
    setBusy(true);
    try {
      const item = await openCloudResourcePicker({ requireReader: true });
      if (item) props.onChange({ type: item.ref.type, id: item.ref.id, title: item.title });
    } catch {
      void prompts.error(t().resourceUnavailable);
    } finally {
      setBusy(false);
    }
  };
  return (
    <TextInput
      name={props.name}
      label={props.label}
      description={props.description}
      required={props.required}
      error={props.error}
      readOnly
      value={value()?.title ?? (value() ? `${value()?.type} · ${value()?.id}` : "")}
      clearable={Boolean(value())}
      onClear={() => props.onChange(null)}
      suffix={
        <Button type="button" variant="ghost" size="sm" disabled={busy()} onClick={() => void choose()}>
          {t().chooseResource}
        </Button>
      }
    />
  );
}
