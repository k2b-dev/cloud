import { coreClient } from "@k2b/cloud/clients/core";
import { PosixOverridesSchema } from "@k2b/cloud/contracts";
import { mutation, query } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import { Band, Bar, Button, Dialog, Facts, Field, Input, Notice, Section, Text } from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import { accountLinuxError, linuxAccountMessages } from "@/shared/linux-messages";
import { useAccountsMessages } from "../../messages";
import type { LinuxSnapshot } from "./user-view";

type NoticeInput = Parameters<typeof import("../../action-notice").showAccountActionNotice>[0];
/** The follow-up notice loads with the deed: it brings v1 dialogs the record does not show otherwise. */
const showAccountActionNotice = async (
  input: NoticeInput,
  t: Parameters<typeof import("../../action-notice").showAccountActionNotice>[1],
) => (await import("../../action-notice")).showAccountActionNotice(input, t);

const api = coreClient.admin.core["linux-identities"].users[":id"];

/**
 * The person's Linux identity: who manages it, its IDs and paths, and the two deeds on it, assigning missing
 * attributes and changing home and shell of a Cloud-managed identity. Each deed asks first and reads the identity again.
 */
export default function LinuxIdentitySection(props: { initial: LinuxSnapshot }) {
  const messages = useAccountsMessages();
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
      await showAccountActionNotice(
        { action: "user.linux", id: user().id, provider: user().provider, profile: user().profile },
        messages(),
      );
      setEditing(false);
    },
  });
  const submit = async (action: "prepare" | "update") => {
    const agreed = await Dialog.confirm({
      title: t().title,
      description: action === "prepare" ? t().confirm : t().confirmPaths,
      confirm: action === "prepare" ? t().prepare : t().save,
      cancel: t().cancel,
    });
    if (agreed) await change.mutate(action);
  };
  const busy = () => change.loading() || snapshot.refreshing();
  const pathsValid = () => PosixOverridesSchema.safeParse({ homeDirectory: home(), loginShell: shell() }).success;
  const canPrepare = () => user().state === "ready" && data().config.enabled;
  const canEdit = () => identity()?.managedBy === "local" && user().provider === "local" && user().profile === "user";
  const startEditing = () => {
    setHome(identity()?.homeDirectory ?? "");
    setShell(identity()?.loginShell ?? "");
    setEditing(true);
  };
  const actions = () => {
    const list = [
      ...(canPrepare() ? [{ label: t().prepare, icon: "id", onClick: () => void submit("prepare"), disabled: busy() }] : []),
      ...(canEdit() && !editing() ? [{ label: t().edit, icon: "pencil", onClick: startEditing, disabled: busy() }] : []),
    ];
    return list.length === 2 ? ([list[0]!, list[1]!] as const) : list.length === 1 ? ([list[0]!] as const) : undefined;
  };
  const problem = () => {
    const state = user().state;
    return state === "provider_changed"
      ? t().sourceChanged
      : state === "identity_conflict"
        ? t().identity_conflict
        : state === "invalid_name"
          ? t().invalid_name
          : state === "group_conflict"
            ? t().group_conflict
            : null;
  };
  return (
    <Section
      icon="terminal-2"
      title={t().title}
      summary={`${t().description} ${(identity()?.managedBy ?? user().provider) === "ipa" ? t().managedIpa : t().managedLocal}`}
      actions={actions()}
      more={{ label: t().settings, href: "/admin/signin/linux", forward: true }}
    >
      <Show when={problem()}>
        {(message) => (
          <Notice tone="bad" icon="alert-circle">
            {message()}
          </Notice>
        )}
      </Show>
      <Show when={!data().config.enabled && user().provider === "local"}>
        <Text muted>{t().disabled}</Text>
      </Show>
      <Show when={user().state === "ipa_pending"}>
        <Text muted>{t().incomplete}</Text>
      </Show>
      <Show when={user().profile === "guest" && user().provider === "local"}>
        <Text muted>{t().guest}</Text>
      </Show>
      <Show when={identity()}>
        {(value) => (
          <Facts
            items={[
              { label: t().uid, value: String(value().uidNumber ?? t().missing), mono: value().uidNumber !== null },
              { label: t().gid, value: String(value().primaryGidNumber ?? t().missing), mono: value().primaryGidNumber !== null },
              { label: t().home, value: value().homeDirectory ?? t().missing, mono: value().homeDirectory !== null },
              { label: t().shell, value: value().loginShell ?? t().missing, mono: value().loginShell !== null },
            ]}
          />
        )}
      </Show>
      <Show when={change.error() ?? snapshot.error()}>
        {(failure) => (
          <Notice tone="bad" icon="alert-circle">
            {failure().message}
          </Notice>
        )}
      </Show>
      <Show when={editing()}>
        <Band>
          <Text muted>{t().pathsHint}</Text>
          <Field name="home" label={t().home} error={pathsValid() ? undefined : t().invalid_paths}>
            <Input value={home()} onInput={setHome} disabled={busy()} />
          </Field>
          <Field name="shell" label={t().shell}>
            <Input value={shell()} onInput={setShell} disabled={busy()} />
          </Field>
        </Band>
        <Bar
          end={
            <>
              <Button disabled={busy()} onClick={() => setEditing(false)}>
                {t().cancel}
              </Button>
              <Button busy={change.loading()} disabled={!pathsValid()} onClick={() => void submit("update")}>
                {t().save}
              </Button>
            </>
          }
        />
      </Show>
    </Section>
  );
}
