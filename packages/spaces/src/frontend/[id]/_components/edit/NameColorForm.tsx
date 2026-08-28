import { Button, ColorInput, TextInput } from "@k2b/ui";
import { createSignal } from "solid-js";
import { useSpaceMessages } from "../../messages";

export function NameColorForm(props: {
  mode: "create" | "edit";
  initialName?: string;
  initialColor?: string | null;
  nameLabel: string;
  namePlaceholder: string;
  createLabel: string;
  onSave: (data: { name: string; color: string }) => void;
  onCancel: () => void;
  loading: boolean;
}) {
  const m = useSpaceMessages();
  const [name, setName] = createSignal(props.initialName ?? "");
  const [color, setColor] = createSignal(props.initialColor ?? "#6b7280");

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    if (!name().trim()) return;
    props.onSave({ name: name(), color: color() });
    if (props.mode === "create") {
      setName("");
      setColor("#6b7280");
    }
  };

  return (
    <form onSubmit={handleSubmit} class="flex flex-col gap-2 py-2">
      <TextInput label={props.nameLabel} placeholder={props.namePlaceholder} value={name} onValueChange={setName} required />
      <ColorInput label={m.color} value={color} onValueChange={setColor} />
      <div class="flex gap-2 mt-1">
        <Button type="submit" disabled={props.loading} size="sm">
          {props.loading ? <i class="ti ti-loader-2 animate-spin" /> : props.mode === "create" ? props.createLabel : m.save}
        </Button>
        <Button type="button" onClick={props.onCancel} variant="secondary" size="sm">
          {m.cancel}
        </Button>
      </div>
    </form>
  );
}
