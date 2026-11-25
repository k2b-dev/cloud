import { useLocale } from "@k2b/ui";
import { Button, Dialog, Field, Input, Select } from "@k2b/ui/v2";
import { createSignal } from "solid-js";
import { spaceColorOptions } from "../../../_components/space-colors";
import { useSpaceMessages } from "../../messages";

/**
 * A name and a colour in a dialog, for a new or a renamed tag or status. It closes when the save starts; the section
 * says when a save fails.
 */
export function NameColorDialog(props: {
  title: string;
  initialName?: string;
  initialColor?: string | null;
  namePlaceholder: string;
  confirmLabel: string;
  busy: boolean;
  onSave: (data: { name: string; color: string }) => void;
  onClose: () => void;
}) {
  const m = useSpaceMessages();
  const locale = useLocale();
  const [name, setName] = createSignal(props.initialName ?? "");
  const [color, setColor] = createSignal(props.initialColor ?? "#6b7280");
  const [missing, setMissing] = createSignal(false);
  const save = () => {
    if (!name().trim()) return setMissing(true);
    props.onSave({ name: name().trim(), color: color() });
  };
  return (
    <Dialog
      title={props.title}
      open
      onOpenChange={(open) => !open && props.onClose()}
      foot={
        <>
          <Button onClick={() => props.onClose()}>{m.cancel}</Button>
          <Button variant="primary" busy={props.busy} onClick={save}>
            {props.confirmLabel}
          </Button>
        </>
      }
    >
      <Field label={m.name} name="name" error={missing() ? m.nameRequired : undefined} required>
        <Input
          value={name()}
          placeholder={props.namePlaceholder}
          onInput={(value) => {
            setName(value);
            setMissing(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.isComposing) save();
          }}
        />
      </Field>
      <Field label={m.color} name="color">
        {/* k2b-ui gap: v2 has no colour input; the named palette, with the current colour as its own entry. */}
        <Select value={color()} options={spaceColorOptions(locale(), color())} onChange={setColor} />
      </Field>
    </Dialog>
  );
}
