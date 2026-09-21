import { Button, Dropdown, NoticeCard, Placeholder, prompts, Select, TextInput, useLocale } from "@k2b/ui";
import { createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { artifactClient } from "./client";
import { type HttpScope, type SecretMetadata, SecretSave } from "./http-contracts";
import type { HttpHost } from "./http-host";
import { artifactMessages } from "./messages";
import { secretDialogMessages } from "./secret-dialog-messages";

type SecretEntry = Awaited<ReturnType<typeof artifactClient.secrets>>[number];
const errorCode = (error: unknown) => (error && typeof error === "object" && "code" in error ? error.code : undefined);
function closeOnAbort(signal: AbortSignal | undefined, close: () => void) {
  signal?.addEventListener("abort", close, { once: true });
  onCleanup(() => signal?.removeEventListener("abort", close));
  if (signal?.aborted) close();
}
export async function openSecretsDialog(
  scope: HttpScope,
  initial?: SecretMetadata,
  signal?: AbortSignal,
): Promise<{ configured: boolean; name: string }> {
  if (initial) {
    const name = await openSecretEditor(scope, initial, undefined, signal);
    return { configured: !!name, name: name ?? initial.name };
  }
  let savedName = "";
  await prompts.dialog<void>(
    (close) => {
      closeOnAbort(signal, close);
      return (
        <SecretsDialog
          scope={scope}
          signal={signal}
          saved={(name) => {
            savedName = name;
          }}
        />
      );
    },
    { title: "Secrets", size: "medium" },
  );
  return { configured: !!savedName, name: savedName };
}
function SecretsDialog(props: { scope: HttpScope; signal?: AbortSignal; saved: (name: string) => void }) {
  const locale = useLocale(),
    t = () => artifactMessages.resolve([locale()]).t,
    copy = () => secretDialogMessages.resolve([locale()]).t;
  const [entries, { refetch }] = createResource(() => artifactClient.secrets(props.scope));
  const [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal("");
  async function edit(entry?: SecretEntry) {
    const name = await openSecretEditor(props.scope, entry, entry?.revision, props.signal);
    await refetch();
    if (name) props.saved(name);
  }
  return (
    <div class="flex flex-col gap-3">
      <p class="text-sm text-secondary">{copy().help}</p>
      <span class="text-xs text-secondary">{props.scope.resourceId ? copy().scopeApp : copy().scopeChat}</span>
      <Show when={error()}>
        <NoticeCard tone="danger" title={error()} />
      </Show>
      <Show when={entries.loading}>
        <Placeholder state="loading" />
      </Show>
      <Show when={!entries.loading && entries.error}>
        <Placeholder state="error" title={t().REQUEST_FAILED} action={<Button onClick={() => void refetch()}>{t().refresh}</Button>} />
      </Show>
      <Show when={!entries.loading && !entries.error}>
        <Show
          when={entries()?.length}
          fallback={<Placeholder title={t().noSecrets} icon="ti ti-key" action={<Button onClick={() => edit()}>{copy().add}</Button>} />}
        >
          <div class="max-h-80 overflow-auto">
            <For each={entries()}>
              {(entry) => (
                <div class="flex items-center gap-3 border-b border-[var(--ui-border)] py-3">
                  <i class="ti ti-key text-secondary" aria-hidden="true" />
                  <div class="min-w-0 flex-1">
                    <strong class="block truncate">{entry.name}</strong>
                    <p class="truncate text-sm text-secondary" title={entry.origin}>
                      {entry.origin}
                    </p>
                    <p class="truncate text-xs text-secondary">
                      {entry.header} ·{" "}
                      {entry.prefix === "Bearer "
                        ? copy().bearer
                        : entry.prefix
                          ? `${copy().custom}: ${JSON.stringify(entry.prefix)}`
                          : copy().apiKey}
                    </p>
                  </div>
                  <Dropdown.Root
                    items={[
                      { label: t().secretReplace, icon: "ti ti-refresh", action: () => edit(entry) },
                      {
                        label: t().remove,
                        icon: "ti ti-trash",
                        action: async () => {
                          if (!(await prompts.confirm(t().secretDeleteConfirm, { title: t().remove, variant: "danger" }))) return;
                          setBusy(true);
                          setError("");
                          try {
                            await artifactClient.removeSecret(props.scope, entry.name, entry.revision);
                            await refetch();
                          } catch (error) {
                            setError(errorCode(error) === "HTTP_CONFLICT" ? copy().conflict : copy().failed);
                          } finally {
                            setBusy(false);
                          }
                        },
                      },
                    ]}
                  >
                    <Dropdown.Trigger iconOnly variant="ghost" disabled={busy()} label={`${t().actions} · ${entry.name}`}>
                      <i class="ti ti-dots" />
                    </Dropdown.Trigger>
                  </Dropdown.Root>
                </div>
              )}
            </For>
          </div>
          <div class="flex justify-end">
            <Button onClick={() => edit()}>{copy().add}</Button>
          </div>
        </Show>
      </Show>
    </div>
  );
}
function openSecretEditor(scope: HttpScope, initial?: SecretMetadata, revision?: string, signal?: AbortSignal) {
  return prompts.dialog<string>(
    (close) => {
      closeOnAbort(signal, () => close());
      return <SecretEditor scope={scope} initial={initial} revision={revision} close={close} />;
    },
    { title: initial?.name ? `Secret · ${initial.name}` : "Secret", size: "medium" },
  );
}
function SecretEditor(props: { scope: HttpScope; initial?: SecretMetadata; revision?: string; close: (name?: string) => void }) {
  const locale = useLocale(),
    t = () => artifactMessages.resolve([locale()]).t,
    copy = () => secretDialogMessages.resolve([locale()]).t;
  const [name, setName] = createSignal(props.initial?.name ?? ""),
    [origin, setOrigin] = createSignal(props.initial?.origin ?? "");
  const [header, setHeader] = createSignal(props.initial?.header ?? "authorization"),
    [prefix, setPrefix] = createSignal(props.initial?.prefix ?? "Bearer ");
  const [value, setValue] = createSignal(""),
    [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal("");
  const [fields, setFields] = createSignal<Record<string, string>>({});
  const [auth, setAuth] = createSignal(
    !props.initial || (props.initial.header === "authorization" && props.initial.prefix === "Bearer ")
      ? "bearer"
      : props.initial.prefix
        ? "custom"
        : "key",
  );
  let form: HTMLFormElement | undefined;
  onCleanup(() => setValue(""));
  function fieldError(field: string) {
    return fields()[field];
  }
  async function save() {
    if (busy()) return;
    setError("");
    setFields({});
    const parsed = SecretSave.safeParse({
      name: name(),
      origin: origin(),
      header: header(),
      prefix: prefix(),
      value: value(),
      expectedRevision: props.revision ?? null,
    });
    if (!parsed.success) {
      const messages: Record<string, string> = {
        name: copy().name,
        origin: copy().origin,
        header: copy().header,
        prefix: copy().prefix,
        value: copy().value,
      };
      setFields(
        Object.fromEntries(parsed.error.issues.map((issue) => [String(issue.path[0]), messages[String(issue.path[0])] ?? copy().failed])),
      );
      queueMicrotask(() => form?.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    setBusy(true);
    try {
      await artifactClient.saveSecret(props.scope, parsed.data);
      setValue("");
      props.close(parsed.data.name);
    } catch (error) {
      if (errorCode(error) === "HTTP_CONFLICT" && !props.revision) setFields({ name: copy().duplicate });
      else setError(errorCode(error) === "HTTP_CONFLICT" ? copy().conflict : copy().failed);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      ref={form}
      noValidate
      class="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Show when={error()}>
        <NoticeCard tone="danger" title={error()} />
      </Show>
      <TextInput
        label={t().secretName}
        value={name}
        onValueChange={setName}
        disabled={busy() || !!props.revision}
        error={() => fieldError("name")}
        maxLength={80}
      />
      <TextInput
        label={t().secretOrigin}
        description={copy().target}
        value={origin}
        onValueChange={setOrigin}
        disabled={busy()}
        error={() => fieldError("origin")}
        placeholder="https://api.example.com"
      />
      <Select
        label={copy().auth}
        value={auth}
        disabled={busy()}
        options={[
          { id: "bearer", label: copy().bearer },
          { id: "key", label: copy().apiKey },
          { id: "custom", label: copy().custom },
        ]}
        onValueChange={(mode) => {
          setAuth(mode ?? "custom");
          if (mode === "bearer") {
            setHeader("authorization");
            setPrefix("Bearer ");
          } else if (mode === "key") {
            setHeader("x-api-key");
            setPrefix("");
          }
        }}
      />
      <Show when={auth() !== "bearer"}>
        <TextInput label={t().secretHeader} value={header} onValueChange={setHeader} disabled={busy()} error={() => fieldError("header")} />
      </Show>
      <Show when={auth() === "custom"}>
        <TextInput
          label={copy().customPrefix}
          value={prefix}
          onValueChange={setPrefix}
          disabled={busy()}
          error={() => fieldError("prefix")}
        />
      </Show>
      <TextInput
        label={t().secretValue}
        password
        value={value}
        onValueChange={setValue}
        disabled={busy()}
        error={() => fieldError("value")}
        autocomplete="new-password"
      />
      <div class="flex justify-end gap-2">
        <Button variant="secondary" onClick={() => props.close()}>
          {copy().cancel}
        </Button>
        <Button type="submit" disabled={busy()}>
          {t().save}
        </Button>
      </div>
    </form>
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
