import { createSignal, Show } from "solid-js";
import { Button, Notice } from "@k2b/ui/v2";
import { ComboboxField, type ComboboxOption, Dialog, DialogCancel } from "@k2b/ui/v2/overlays";

/** "Neue Nachricht": ui-sdk Dialog with a ui-sdk Combobox for the recipient. */
export default function NewMessage(props: { contacts: ComboboxOption[] }) {
  const [open, setOpen] = createSignal(false);
  const [to, setTo] = createSignal<string | null>(null);
  const [missing, setMissing] = createSignal(false);
  const [sent, setSent] = createSignal("");
  const send = () => {
    if (!to()) return setMissing(true);
    setMissing(false);
    setSent(`Nachricht an ${props.contacts.find((c) => c.value === to())?.label} gesendet.`);
    setOpen(false);
    setTo(null);
  };
  return (
    <>
      <Dialog
        open={open()}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setMissing(false);
        }}
        trigger={{ label: "Neue Nachricht", icon: "pencil", variant: "primary" }}
        title="Neue Nachricht"
        notice={
          <Show when={missing()}>
            <Notice tone="bad" title="Empfänger fehlt" text="Wähle zuerst, an wen die Nachricht geht." />
          </Show>
        }
        footer={
          <>
            <DialogCancel>Abbrechen</DialogCancel>
            <Button variant="primary" icon="send" onClick={send}>
              Senden
            </Button>
          </>
        }
      >
        <ComboboxField label="An" placeholder="Name oder Adresse" options={props.contacts} value={to()} onValueChange={setTo} />
        <label class="k2-field">
          <span class="k2-field__label">Betreff</span>
          <input class="k2-input" name="subject" />
        </label>
        <label class="k2-field">
          <span class="k2-field__label">Nachricht</span>
          <textarea class="k2-input" name="body" />
        </label>
      </Dialog>
      <span class="k2-sr" role="status" data-testid="sent">
        {sent()}
      </span>
    </>
  );
}
