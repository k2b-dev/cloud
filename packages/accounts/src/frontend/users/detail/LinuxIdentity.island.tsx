import { mutation, query } from "@k2b/stdlib/solid";
import { Button, ButtonLink, NoticeCard, prompts, SettingsSection, TextInput, useLocale } from "@k2b/ui";
import { coreClient } from "@valentinkolb/cloud/clients/core";
import { PosixOverridesSchema } from "@valentinkolb/cloud/contracts";
import type { linuxIdentities } from "@valentinkolb/cloud/services";
import { createSignal, For, Show } from "solid-js";
import { accountLinuxError, linuxAccountMessages } from "../../linux-messages";

type Snapshot = Awaited<ReturnType<typeof linuxIdentities.get>>;
const api = coreClient.admin.core["linux-identities"].users[":id"];

export default function LinuxIdentity(props: { initial: Snapshot }) {
  const locale = useLocale();
  const t = () => linuxAccountMessages.resolve([locale()]).t;
  const [editing, setEditing] = createSignal(false);
  const [home, setHome] = createSignal("");
  const [shell, setShell] = createSignal("");
  const snapshot = query.create({
    source: () => props.initial.user.id,
    initial: { source: props.initial.user.id, data: props.initial },
    load: async (id, { abortSignal }) => {
      const response = await api.$get({ param: { id } }, { init: { signal: abortSignal } });
      if (!response.ok) throw await accountLinuxError(response, t());
      return response.json();
    },
  });
  const data = () => snapshot.data() ?? props.initial;
  const user = () => data().user;
  const identity = () => user().identity;
  const change = mutation.create<void, "prepare" | "update">({
    mutation: async (action) => {
      const param = { id: user().id };
      const response =
        action === "prepare"
          ? await api.$post({ param })
          : await api.$patch({ param, json: { homeDirectory: home(), loginShell: shell() } });
      if (!response.ok) throw await accountLinuxError(response, t());
      await snapshot.invalidate();
      setEditing(false);
    },
  });
  const submit = async (action: "prepare" | "update") => {
    if (
      await prompts.confirm(action === "prepare" ? t().confirm : t().confirmPaths, {
        title: t().title,
        confirmText: action === "prepare" ? t().prepare : t().save,
      })
    )
      await change.mutate(action);
  };
  const busy = () => change.loading() || snapshot.refreshing();
  return (
    <SettingsSection title={t().title} subtitle={t().description} icon="ti ti-terminal-2">
      <div class="flex flex-col gap-3">
        <NoticeCard tone="info">{(identity()?.managedBy ?? user().provider) === "ipa" ? t().managedIpa : t().managedLocal}</NoticeCard>
        <Show when={!data().config.enabled && user().provider === "local"}>
          <p class="text-sm text-dimmed">{t().disabled}</p>
        </Show>
        <Show when={user().state === "ipa_pending"}>
          <p role="status" class="text-sm text-dimmed">
            {t().incomplete}
          </p>
        </Show>
        <Show when={user().state === "provider_changed"}>
          <NoticeCard tone="danger" role="alert">
            {t().sourceChanged}
          </NoticeCard>
        </Show>
        <Show when={user().state === "identity_conflict"}>
          <NoticeCard tone="danger" role="alert">
            {t().identity_conflict}
          </NoticeCard>
        </Show>
        <Show when={user().profile === "guest" && user().provider === "local"}>
          <p class="text-sm text-dimmed">{t().guest}</p>
        </Show>
        <Show when={user().state === "invalid_name" || user().state === "group_conflict"}>
          <NoticeCard tone="danger" role="alert">
            {user().state === "invalid_name" ? t().invalid_name : t().group_conflict}
          </NoticeCard>
        </Show>
        <Show when={identity()}>
          {(value) => (
            <dl class="grid gap-3 sm:grid-cols-2">
              <For
                each={[
                  [t().uid, value().uidNumber],
                  [t().gid, value().primaryGidNumber],
                  [t().home, value().homeDirectory],
                  [t().shell, value().loginShell],
                ]}
              >
                {([label, content]) => (
                  <div>
                    <dt class="text-xs text-dimmed">{label}</dt>
                    <dd class="break-all font-mono text-sm">{content ?? t().missing}</dd>
                  </div>
                )}
              </For>
            </dl>
          )}
        </Show>
        <Show when={change.error() || snapshot.error()}>
          <NoticeCard tone="danger" role="alert">
            {change.error()?.message ?? snapshot.error()?.message}
          </NoticeCard>
        </Show>
        <Show
          when={editing()}
          fallback={
            <div class="flex flex-wrap gap-2">
              <Show when={user().state === "ready" && data().config.enabled}>
                <Button size="sm" disabled={busy()} onClick={() => void submit("prepare")}>
                  {t().prepare}
                </Button>
              </Show>
              <Show when={identity()?.managedBy === "local" && user().provider === "local" && user().profile === "user"}>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy()}
                  onClick={() => {
                    setHome(identity()?.homeDirectory ?? "");
                    setShell(identity()?.loginShell ?? "");
                    setEditing(true);
                  }}
                >
                  {t().edit}
                </Button>
              </Show>
              <ButtonLink href="/admin/settings?tab=linux" size="sm" variant="secondary">
                {t().settings}
              </ButtonLink>
            </div>
          }
        >
          <p class="text-sm text-dimmed">{t().pathsHint}</p>
          <TextInput label={t().home} value={home()} onValueChange={setHome} disabled={busy()} />
          <TextInput label={t().shell} value={shell()} onValueChange={setShell} disabled={busy()} />
          <Show when={!PosixOverridesSchema.safeParse({ homeDirectory: home(), loginShell: shell() }).success}>
            <NoticeCard tone="danger" role="alert">
              {t().invalid_paths}
            </NoticeCard>
          </Show>
          <div class="flex gap-2">
            <Button
              size="sm"
              disabled={busy() || !PosixOverridesSchema.safeParse({ homeDirectory: home(), loginShell: shell() }).success}
              onClick={() => void submit("update")}
            >
              {t().save}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy()} onClick={() => setEditing(false)}>
              {t().cancel}
            </Button>
          </div>
        </Show>
      </div>
    </SettingsSection>
  );
}
