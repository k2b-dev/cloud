import { Button, Dialog, Field, Input } from "@k2b/ui/v2";
import { createSignal } from "solid-js";
import type { spaceMessages } from "../../../messages";

type Messages = ReturnType<typeof spaceMessages.resolve>["t"];

/** The release of a claim with an optional handoff note; closes with the note, or null when the person cancels. */
export default function ReleaseNoteDialog(props: { t: Messages; close: (note: string | null) => void }) {
  const [note, setNote] = createSignal("");
  return (
    <Dialog
      title={props.t.releaseNoteTitle}
      open
      onOpenChange={(open) => !open && props.close(null)}
      foot={
        <>
          <Button onClick={() => props.close(null)}>{props.t.cancel}</Button>
          <Button variant="primary" onClick={() => props.close(note().slice(0, 5000))}>
            {props.t.releaseClaim}
          </Button>
        </>
      }
    >
      <Field label={props.t.releaseNoteLabel} name="release-note">
        <Input multiline value={note()} placeholder={props.t.releaseNotePlaceholder} onInput={setNote} />
      </Field>
    </Dialog>
  );
}
