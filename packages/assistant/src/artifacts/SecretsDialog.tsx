import { Button, TextInput, NoticeCard, Placeholder, prompts, useLocale } from "@k2b/ui";
import { createResource, createSignal, For, Show, onCleanup } from "solid-js";
import { artifactClient } from "./client";
import { HttpScope, SecretSave, type SecretMetadata } from "./http-contracts";
import { artifactMessages } from "./messages";
import type { HttpHost } from "./http-host";

export function openSecretsDialog(
  scope: HttpScope,
  initial?: SecretMetadata,
  signal?: AbortSignal,
): Promise<{ configured: boolean; name: string }> {
  let result = { configured: false, name: initial?.name ?? "" };
  return prompts
    .dialog<void>(
      (close) => {
        const abort = () => close();
        signal?.addEventListener("abort", abort, { once: true });
        onCleanup(() => signal?.removeEventListener("abort", abort));
        if (signal?.aborted) close();
        return (
          <SecretsDialog
            scope={scope}
            initial={initial}
            saved={(name) => {
              result = { configured: true, name };
              if (initial) close();
            }}
          />
        );
      },
      { title: "Secrets", size: "medium" },
    )
    .then(() => result);
}
function SecretsDialog(props: { scope: HttpScope; initial?: SecretMetadata; saved: (name: string) => void }) {
  const locale = useLocale(),
    t = () => artifactMessages.resolve([locale()]).t;
  const [entries, { refetch }] = createResource(() => artifactClient.secrets(props.scope));
  const [name, setName] = createSignal(props.initial?.name ?? ""),
    [origin, setOrigin] = createSignal(props.initial?.origin ?? "");
  const [header, setHeader] = createSignal(props.initial?.header ?? "authorization"),
    [prefix, setPrefix] = createSignal(props.initial?.prefix ?? "Bearer ");
  const [value, setValue] = createSignal(""),
    [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal("");
  const [revision, setRevision] = createSignal<string | null>(null);
  // Values never enter local storage, a chat draft, or a tool response.
  onCleanup(() => setValue(""));
  const edit = (entry: NonNullable<ReturnType<typeof entries>>[number]) => {
    setName(entry.name);
    setOrigin(entry.origin);
    setHeader(entry.header);
    setPrefix(entry.prefix);
    setRevision(entry.revision);
    setValue("");
    setError("");
  };
  async function save() {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      const input = SecretSave.parse({
        name: name(),
        origin: origin(),
        header: header(),
        prefix: prefix(),
        value: value(),
        expectedRevision: revision(),
      });
      const stored = await artifactClient.saveSecret(props.scope, input);
      setValue("");
      setRevision(stored.revision);
      await refetch();
      props.saved(stored.name);
    } catch {
      setError(t().secretSaveError);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="flex flex-col gap-4">
      <NoticeCard tone="info" title={t().personalSecrets} detail={t().secretHelp} />
      <Show when={entries.error}>
        <Placeholder state="error" title={t().REQUEST_FAILED} action={<Button onClick={() => void refetch()}>{t().refresh}</Button>} />
      </Show>
      <Show when={entries.loading}>
        <Placeholder state="loading" />
      </Show>
      <For each={entries()}>
        {(entry) => (
          <div class="flex items-center gap-2">
            <div class="flex-1 min-w-0">
              <strong>{entry.name}</strong>
              <p class="text-sm break-all">
                {entry.origin} · {entry.header}
              </p>
            </div>
            <Button variant="secondary" disabled={busy()} onClick={() => edit(entry)}>
              {t().secretReplace}
            </Button>
            <Button
              variant="secondary"
              disabled={busy()}
              onClick={async () => {
                if (!(await prompts.confirm(t().secretDeleteConfirm, { title: t().remove, variant: "danger" }))) return;
                setBusy(true);
                setError("");
                try {
                  await artifactClient.removeSecret(props.scope, entry.name, entry.revision);
                  if (name() === entry.name) setRevision(null);
                  await refetch();
                } catch {
                  setError(t().secretSaveError);
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
      <Show when={!entries.loading && !entries()?.length}>
        <p>{t().noSecrets}</p>
      </Show>
      <Show when={error()}>
        <NoticeCard tone="danger" title={error()} />
      </Show>
      <form
        class="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <TextInput
          label={t().secretName}
          value={name}
          onValueChange={(v) => {
            setName(v);
            setRevision(null);
          }}
          disabled={busy()}
          maxLength={80}
        />
        <TextInput
          label={t().secretOrigin}
          value={origin}
          onValueChange={setOrigin}
          disabled={busy()}
          placeholder="https://api.example.com"
        />
        <TextInput label={t().secretHeader} value={header} onValueChange={setHeader} disabled={busy()} />
        <TextInput label={t().secretPrefix} value={prefix} onValueChange={setPrefix} disabled={busy()} />
        <TextInput label={t().secretValue} password value={value} onValueChange={setValue} disabled={busy()} autocomplete="new-password" />
        <Button type="submit" disabled={busy() || !value() || entries.loading || !!entries.error}>
          {t().save}
        </Button>
      </form>
    </div>
  );
}

export const browserHttpHost: HttpHost = {
  secret: openSecretsDialog,
  approve: async (request, signal) => {
    let approved = false;
    await prompts.dialog<void>(
      (close) => {
        const locale = useLocale(),
          t = () => artifactMessages.resolve([locale()]).t;
        const abort = () => close();
        signal.addEventListener("abort", abort, { once: true });
        onCleanup(() => signal.removeEventListener("abort", abort));
        if (signal.aborted) close();
        return (
          <div class="flex flex-col gap-3">
            <NoticeCard tone="warning" title={request.resourceTitle ?? t().httpRequest} detail={t().httpConsent} />
            <p class="break-all">
              <strong>{request.method}</strong> {request.url}
            </p>
            <pre class="max-h-48 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(request.headers, null, 2)}</pre>
            <Show when={request.bodyBytes}>
              <p>{request.bodyBytes} bytes</p>
              <pre class="max-h-48 overflow-auto whitespace-pre-wrap break-all">{request.bodyPreview}</pre>
              <Show when={request.bodyTruncated}>
                <p>{t().httpTruncated}</p>
              </Show>
            </Show>
            <div class="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => close()}>
                {t().stop}
              </Button>
              <Button
                onClick={() => {
                  approved = true;
                  close();
                }}
              >
                {t().httpApprove}
              </Button>
            </div>
          </div>
        );
      },
      { title: request.method + " · " + new URL(request.url).host, size: "medium" },
    );
    return approved;
  },
};
