import { Button, Dialog, Field, Input, Lookup, type LookupLoad, Notice } from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import { useAccountsMessages } from "../../messages";
import type { DeedResult } from "./group-deeds";
import { useGroupDetailMessages } from "./messages";

/** Longest description the server takes. */
const DESCRIPTION_MAX = 4000;

/**
 * Adds one or several entries found in the directory: tick them in the lookup, then "Add". The entries are added one
 * after the other; a refusal stops there, names the reason, and keeps the rest ticked, so "Add" again goes on.
 */
export function AddEntriesDialog(props: {
  title: string;
  /** What the lookup searches, such as "Users and groups". */
  lookup: string;
  load: LookupLoad;
  add: (key: string) => Promise<DeedResult>;
  /** `added`: how many were added, so the page shows them. */
  close: (added: number) => void;
}) {
  const t = useGroupDetailMessages();
  const accounts = useAccountsMessages();
  const [chosen, setChosen] = createSignal<string[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [added, setAdded] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);
  const submit = async () => {
    if (busy()) return;
    if (chosen().length === 0) return setError(t().chooseFirst);
    setBusy(true);
    setError(null);
    try {
      for (const key of chosen()) {
        const result = await props.add(key);
        if (!result.ok) return setError(added() > 0 ? `${t().addedPart({ count: added() })} ${result.message}` : result.message);
        setAdded((count) => count + 1);
        setChosen((keys) => keys.filter((entry) => entry !== key));
      }
      props.close(added());
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    if (!busy()) props.close(added());
  };
  return (
    <Dialog
      title={props.title}
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      foot={
        <>
          <Button onClick={close} disabled={busy()}>
            {accounts().cancel}
          </Button>
          <Button variant="primary" icon="plus" busy={busy()} onClick={() => void submit()}>
            {t().addChosen({ count: chosen().length })}
          </Button>
        </>
      }
    >
      <Lookup label={props.lookup} value={chosen()} onChange={setChosen} load={props.load} />
      <Show when={error()}>
        {(message) => (
          <Notice tone="bad" icon="alert-circle">
            {message()}
          </Notice>
        )}
      </Show>
    </Dialog>
  );
}

/** Changes a group's description. */
export function DescriptionDialog(props: {
  description: string | null;
  save: (description: string) => Promise<DeedResult>;
  close: (saved: boolean) => void;
}) {
  const t = useGroupDetailMessages();
  const accounts = useAccountsMessages();
  const [description, setDescription] = createSignal(props.description ?? "");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // k2b-ui gap: v2 Input has no maxLength; the dialog holds the server's limit itself.
  const tooLong = () => description().length > DESCRIPTION_MAX;
  const save = async () => {
    if (busy() || tooLong()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await props.save(description().trim());
      if (result.ok) props.close(true);
      else setError(result.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={accounts().editGroup}
      open
      onOpenChange={(open) => {
        if (!open && !busy()) props.close(false);
      }}
      foot={
        <>
          <Button onClick={() => props.close(false)} disabled={busy()}>
            {accounts().cancel}
          </Button>
          <Button variant="primary" busy={busy()} onClick={() => void save()}>
            {accounts().save}
          </Button>
        </>
      }
    >
      <Field
        name="description"
        label={accounts().description}
        hint={t().descriptionHint}
        error={tooLong() ? t().descriptionTooLong : undefined}
        optional={t().optional}
      >
        <Input
          multiline
          value={description()}
          placeholder={accounts().groupDescriptionPlaceholder}
          disabled={busy()}
          onInput={setDescription}
        />
      </Field>
      <Show when={error()}>
        {(message) => (
          <Notice tone="bad" icon="alert-circle">
            {message()}
          </Notice>
        )}
      </Show>
    </Dialog>
  );
}
