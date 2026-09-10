import { mutation, query } from "@k2b/stdlib/solid";
import { Button, Select, TextInput, Placeholder, prompts, useLocale } from "@k2b/ui";
import { coreClient } from "@k2b/cloud/clients/core";
import type { serviceAccountCredentials } from "@k2b/cloud/services";
import { createSignal, For, Show, onCleanup } from "solid-js";
import { credentialMessages } from "./messages";

type Listing = Awaited<ReturnType<typeof serviceAccountCredentials.listOverview>>;
type Props = { apps: Array<{ id: string; name: string }>; appId: string; initial: Listing | null };
const api = coreClient.admin.identity.workloads;

export default function Credentials(props: Props) {
  const locale = useLocale();
  const t = () => credentialMessages.resolve([locale()]).t;
  const [appId, setAppId] = createSignal(props.appId);
  const [page, setPage] = createSignal(1);
  const [name, setName] = createSignal("");
  const [expiresAt, setExpiresAt] = createSignal("");
  const [created, setCreated] = createSignal<{ appId: string; token: string } | null>(null);
  const [revision, setRevision] = createSignal(0);
  const entries = query.create({
    source: () => ({ appId: appId(), page: page(), revision: revision() }),
    load: async (source, { abortSignal }): Promise<Listing | null> => {
      if (!source.appId) return null;
      if (source.appId === props.appId && source.page === 1 && source.revision === 0) return props.initial;
      const response = await api[":appId"].credentials.$get(
        { param: { appId: source.appId }, query: { page: String(source.page), perPage: "20" } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(t().failed);
      return response.json();
    },
  });
  const create = mutation.create({
    mutation: async (_: void, { abortSignal }) => {
      const selected = appId();
      const response = await api[":appId"].credentials.$post(
        {
          param: { appId: selected },
          json: { name: name().trim(), scopes: ["identity:invoke"], ...(expiresAt().trim() ? { expiresAt: expiresAt().trim() } : {}) },
        },
        { init: { signal: abortSignal } },
      );
      const result = await response.json();
      if (!response.ok || !("token" in result)) throw new Error("message" in result ? result.message : t().failed);
      return { appId: selected, token: result.token };
    },
    onSuccess: (result) => {
      setCreated(result);
      setName("");
      setRevision((v) => v + 1);
    },
    onError: (error) => prompts.error(error.message),
  });
  const revoke = mutation.create<void, { appId: string; credentialId: string }>({
    mutation: async (param, { abortSignal }) => {
      const response = await api[":appId"].credentials[":credentialId"].$delete({ param }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(t().failed);
    },
    onSuccess: () => setRevision((v) => v + 1),
    onError: (error) => prompts.error(error.message),
  });
  onCleanup(() => {
    create.abort();
    revoke.abort();
  });
  const busy = () => create.loading() || revoke.loading();
  return (
    <div class="app-rows">
      <p class="text-xs text-dimmed">{t().rotation}</p>
      <Select
        label={t().app}
        value={appId()}
        options={props.apps.map((app) => ({ id: app.id, label: app.name }))}
        disabled={busy() || created() !== null}
        onValueChange={(value) => {
          if (!value) return;
          setAppId(value);
          setPage(1);
          const url = new URL(window.location.href);
          url.searchParams.set("app", value);
          window.history.replaceState(null, "", url);
        }}
      />
      <Show when={appId()} fallback={<Placeholder state="empty" title={t().noApps} />}>
        <Show when={created()}>
          {(value) => (
            <section class="paper flex flex-col gap-2 p-3">
              <p class="text-sm font-medium">
                {t().once} ({value().appId})
              </p>
              <TextInput multiline label="CLOUD_APP_CREDENTIAL" value={value().token} readOnly />
              <p class="text-xs text-dimmed">{t().hint}</p>
              <Button onClick={() => setCreated(null)}>{t().dismiss}</Button>
            </section>
          )}
        </Show>
        <form
          class="paper flex flex-col gap-3 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate(undefined);
          }}
        >
          <TextInput label={t().name} value={name()} onValueChange={setName} disabled={busy() || !!created()} required maxLength={120} />
          <TextInput
            label={t().expires}
            value={expiresAt()}
            onValueChange={setExpiresAt}
            disabled={busy() || !!created()}
            placeholder="2027-01-01T00:00:00Z"
          />
          <Button type="submit" disabled={busy() || !!created() || !name().trim()}>
            {t().create}
          </Button>
        </form>
        <Show when={!entries.loading()} fallback={<Placeholder state="loading" title={t().loading} />}>
          <Show
            when={!entries.error()}
            fallback={
              <Placeholder state="error" title={t().failed} action={<Button onClick={() => void entries.refresh()}>{t().retry}</Button>} />
            }
          >
            <For each={entries.data()?.items} fallback={<Placeholder state="empty" title={t().empty} />}>
              {(entry) => (
                <div class="paper flex flex-wrap items-center justify-between gap-3 p-3">
                  <div>
                    <p class="text-sm font-medium">{entry.name}</p>
                    <p class="text-xs text-dimmed">
                      {entry.tokenPrefix} · {entry.status} · {entry.expiresAt ?? t().never}
                    </p>
                  </div>
                  <Button
                    variant="danger"
                    disabled={busy() || entry.status === "revoked"}
                    onClick={async () => {
                      const selected = appId();
                      if (await prompts.confirm(t().confirm)) revoke.mutate({ appId: selected, credentialId: entry.id });
                    }}
                  >
                    {t().revoke}
                  </Button>
                </div>
              )}
            </For>
            <div class="flex gap-2">
              <Button disabled={page() <= 1 || busy()} onClick={() => setPage((v) => v - 1)}>
                {t().previous}
              </Button>
              <Button disabled={!entries.data()?.hasNext || busy()} onClick={() => setPage((v) => v + 1)}>
                {t().next}
              </Button>
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  );
}
