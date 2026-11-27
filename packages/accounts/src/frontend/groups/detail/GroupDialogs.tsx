import { Button, Dialog, Field, Input, Lookup, type LookupLoad, Notice } from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import { useAccountsMessages } from "../../messages";
import type { DeedResult } from "./group-deeds";
import { useGroupDetailMessages } from "./messages";

/** Longest description the server takes. */
const DESCRIPTION_MAX = 4000;

/**
 * Adds one or several entries found in the directory: tick them in the lookup, then "Add". Each one is added in
 * turn. Whoever is in the group already (the service refuses them, `already`) is named as such and leaves the choice;
 * any other refusal names its reason and stays ticked, so "Add" again tries those once more. While nothing went
 * wrong the dialog closes; otherwise it stays and says what happened, until "Done".
 */
export function AddEntriesDialog(props: {
  title: string;
  /** What the lookup searches, such as "Users and groups". */
  lookup: string;
  load: LookupLoad;
  add: (key: string) => Promise<DeedResult>;
  /** Whether a refusal means "is in the group already". */
  already: (result: { status?: number }) => boolean;
  /** What the group is to the entries, for "Already a member: …". */
  role: "members" | "managers" | "parents";
  /** `added`: how many were added, so the page shows them. */
  close: (added: number) => void;
}) {
  const t = useGroupDetailMessages();
  const accounts = useAccountsMessages();
  const [chosen, setChosen] = createSignal<string[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [added, setAdded] = createSignal(0);
  const [report, setReport] = createSignal<{ tone: "note" | "bad"; text: string } | null>(null);
  // the names the lookup showed, to name the entries in the report
  const labels = new Map<string, string>();
  const load: LookupLoad = (query, context) =>
    props.load(query, context).then((result) => {
      for (const item of result.items) labels.set(item.value, item.label);
      return result;
    });
  const submit = async () => {
    if (busy()) return;
    if (chosen().length === 0) return setReport({ tone: "bad", text: t().chooseFirst });
    setBusy(true);
    setReport(null);
    try {
      let now = 0;
      const already: string[] = [];
      const refused: string[] = [];
      for (const key of chosen()) {
        const result = await props.add(key);
        const name = labels.get(key) ?? key;
        if (result.ok) now += 1;
        else if (props.already(result)) already.push(name);
        else refused.push(t().refusedFor({ name, reason: result.message }));
        if (result.ok || props.already(result)) setChosen((keys) => keys.filter((entry) => entry !== key));
      }
      setAdded((count) => count + now);
      if (already.length === 0 && refused.length === 0) return props.close(added());
      setReport({
        tone: refused.length > 0 ? "bad" : "note",
        text: [
          now > 0 ? t().addedSome({ count: now }) : null,
          already.length > 0 ? t().alreadyIn({ role: props.role, names: already.join(", ") }) : null,
          ...refused,
        ]
          .filter(Boolean)
          .join(" "),
      });
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
            {report() ? t().done : accounts().cancel}
          </Button>
          <Button variant="primary" icon="plus" busy={busy()} onClick={() => void submit()}>
            {t().addChosen({ count: chosen().length })}
          </Button>
        </>
      }
    >
      <Lookup label={props.lookup} value={chosen()} onChange={setChosen} load={load} />
      <Show when={report()}>
        {(shown) => (
          <Notice tone={shown().tone} icon={shown().tone === "bad" ? "alert-circle" : "info-circle"}>
            {shown().text}
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
