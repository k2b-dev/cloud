import { Button, InlineGuidance, NoticeCard, Placeholder, TextInput, useLocale } from "@k2b/ui";
import { createResource, createSignal, For, Show } from "solid-js";
import { SecretSave } from "./http-contracts";
import { machineClient } from "./machine-client";
import { machineMessages } from "./machine-messages";

type Secret = Awaited<ReturnType<typeof machineClient.secrets>>[number];
export function MachineSecrets(props: { artifactId: string; administrative?: boolean }) {
  const locale = useLocale(),
    t = () => machineMessages.resolve([locale()]).t;
  const [entries, { refetch }] = createResource(() => machineClient.secrets(props.artifactId, props.administrative));
  const [editing, setEditing] = createSignal<{ name: string; origin: string; header: string; prefix: string; revision: string | null }>();
  const [value, setValue] = createSignal("");
  const [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal(false);
  function edit(entry?: Secret) {
    setValue("");
    setError(false);
    setEditing(entry ?? { name: "", origin: "", header: "authorization", prefix: "Bearer ", revision: null });
  }
  async function save() {
    setBusy(true);
    setError(false);
    try {
      const fields = editing()!;
      await machineClient.saveSecret(
        props.artifactId,
        SecretSave.parse({
          name: fields.name,
          origin: fields.origin,
          header: fields.header,
          prefix: fields.prefix,
          value: value(),
          expectedRevision: fields.revision,
        }),
        props.administrative,
      );
      setValue("");
      setEditing(undefined);
      await refetch();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section class="flex min-w-0 flex-col gap-3" aria-label={t().machineSecrets}>
      <h4 class="font-semibold">{t().machineSecrets}</h4>
      <p class="text-sm text-secondary">{t().machineSecretsHelp}</p>
      <Show when={entries.loading}>
        <InlineGuidance loading>{t().loading}</InlineGuidance>
      </Show>
      <Show when={entries.error}>
        <NoticeCard tone="danger" title={t().loadFailed}>
          <Button variant="ghost" onClick={() => void refetch()}>
            {t().refresh}
          </Button>
        </NoticeCard>
      </Show>
      <Show when={!entries.loading && !entries.error && !entries()?.length}>
        <Placeholder title={t().noSecrets} icon="ti ti-key" />
      </Show>
      <For each={entries.error ? [] : entries()}>
        {(entry) => (
          <div class="flex min-w-0 flex-wrap items-center gap-2 border-b border-default py-2">
            <div class="min-w-0 flex-1">
              <strong class="block truncate">{entry.name}</strong>
              <p class="truncate text-sm text-secondary">{entry.origin}</p>
            </div>
            <Button size="sm" variant="ghost" disabled={busy()} onClick={() => edit(entry)}>
              {t().replace}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy()}
              onClick={async () => {
                setBusy(true);
                setError(false);
                try {
                  await machineClient.removeSecret(props.artifactId, entry.name, entry.revision, props.administrative);
                  await refetch();
                } catch {
                  setError(true);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t().remove}
            </Button>
          </div>
        )}
      </For>
      <Show when={!editing()}>
        <Button variant="ghost" disabled={busy() || !!entries.error} onClick={() => edit()}>
          {t().addSecret}
        </Button>
      </Show>
      <Show when={editing()}>
        {(fields) => (
          <form
            class="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <For each={["name", "origin", "header", "prefix"] as const}>
              {(field) => (
                <TextInput
                  label={t()[field]}
                  value={fields()[field]}
                  disabled={busy() || (field === "name" && fields().revision !== null)}
                  onValueChange={(value) => setEditing({ ...fields(), [field]: value })}
                />
              )}
            </For>
            <TextInput label={t().value} password autocomplete="new-password" value={value()} onValueChange={setValue} disabled={busy()} />
            <div class="flex flex-wrap justify-end gap-2">
              <Button
                variant="ghost"
                disabled={busy()}
                onClick={() => {
                  setValue("");
                  setEditing(undefined);
                }}
              >
                {t().cancel}
              </Button>
              <Button type="submit" loading={busy()} disabled={busy()}>
                {t().saveSecret}
              </Button>
            </div>
          </form>
        )}
      </Show>
      <Show when={error()}>
        <NoticeCard tone="danger" title={t().failure}>
          <Button variant="ghost" onClick={() => void refetch()}>
            {t().refresh}
          </Button>
        </NoticeCard>
      </Show>
    </section>
  );
}
