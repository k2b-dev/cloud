import SettingsSaveOutcome from "@k2b/cloud/ssr/SettingsSaveOutcome";
import { createSettingsDraft, saveFailure } from "@k2b/cloud/ssr/settings-draft";
import { Checkbox, NoticeCard, Select, TagsInput, TextInput, useLocale } from "@k2b/ui";
import { createSignal, createUniqueId, For, Show } from "solid-js";
import { apiClient } from "../../api/client";
import { responseErrorMessage } from "../../frontend/health-webhook-queries";
import { gatewayOpsMessages } from "../../messages";
import { natsMessages } from "./messages";

export type NatsAccessValues = { servers: string[]; kind: string; ca: string };
type Values = NatsAccessValues & { access: string; clear: boolean };
type Key = "servers" | "kind" | "access" | "ca";
const keys = ["servers", "kind", "ca", "access"] as const;
const setting: Record<Key, string> = {
  servers: "gateway.nats_admin_servers",
  kind: "gateway.nats_admin_access_kind",
  access: "gateway.nats_admin_access",
  ca: "gateway.nats_admin_tls_ca",
};

export default function NatsAccessForm(props: { values: NatsAccessValues; unreadable: Record<Key, boolean>; accessRequired?: boolean }) {
  const locale = useLocale();
  const t = () => natsMessages.resolve([locale()]).t;
  const g = () => gatewayOpsMessages.resolve([locale()]).t;
  const [unreadable, setUnreadable] = createSignal(props.unreadable);
  const [accessRequired, setAccessRequired] = createSignal(props.accessRequired ?? false);
  const [replace, setReplace] = createSignal<Partial<Record<Key, boolean>>>({});
  const confirmed = (key: Key) => unreadable()[key] && replace()[key] === true;
  const label = (key: Key) => ({ servers: t().accessServers, kind: t().accessKind, access: t().accessSecret, ca: t().accessCa })[key];
  let stored: Values = { ...props.values, access: "", clear: false };
  const serversChanged = (value: NatsAccessValues) => JSON.stringify(value.servers) !== JSON.stringify(stored.servers);
  const form = createSettingsDraft<Values>({
    initial: stored,
    locale,
    onDiscard: () => {
      setReplace({});
      stored = { ...stored, access: "", clear: false };
      form.rebase(stored, ["access", "clear"]);
    },
    pending: () => keys.some(confirmed),
    validate: (value): Record<string, string> =>
      value.servers.length && (serversChanged(value) || accessRequired()) && !value.access && !value.clear
        ? { access: t().accessEndpointHelp }
        : confirmed("access") && !value.access && !value.clear
          ? { access: t().accessReplaceRequired }
          : {},
    save: async (value, commit) => {
      // Save only changed fields, keeping confirmed steps after a partial failure.
      // Changing servers discards saved access. Submit the replacement last.
      for (const key of keys) {
        if (
          key === "access"
            ? !value.clear && !value.access && !confirmed(key)
            : JSON.stringify(value[key]) === JSON.stringify(stored[key]) && !confirmed(key)
        )
          continue;
        if (key === "access" && value.access === stored.access && value.clear === stored.clear && !confirmed(key)) continue;
        const response = await apiClient.settings[":key{.+}"].$put({
          param: { key: setting[key] },
          json: { value: key === "access" && value.clear ? "" : value[key], replaceUnreadable: confirmed(key) },
        });
        if (!response.ok) {
          // A new unreadable conflict always requires explicit replacement.
          if (response.status === 409) setUnreadable({ ...unreadable(), [key]: true });
          throw saveFailure(response.status, await responseErrorMessage(response, g().saveFailed));
        }
        if (key === "servers") setAccessRequired(value.servers.length > 0);
        if (key === "access") setAccessRequired(false);
        stored = { ...stored, [key]: value[key], ...(key === "access" ? { clear: value.clear } : {}) };
        setUnreadable({ ...unreadable(), [key]: false });
        setReplace({ ...replace(), [key]: false });
        commit(stored);
      }
      // Forget submitted secrets once every step is confirmed.
      stored = { ...stored, access: "", clear: false };
      return stored;
    },
  });
  const accessHelpId = createUniqueId();
  const showAccessMessage = () => serversChanged(form.draft()) || accessRequired() || Boolean(form.errors().access);
  const disabled = (key: Key) => form.saving() || (unreadable()[key] && !replace()[key]);
  return (
    <div class="flex max-w-2xl flex-col gap-4 px-[var(--ui-space-shell)] pb-[var(--ui-space-shell)]">
      <SettingsSaveOutcome outcome={form.outcome()} onRetry={() => void form.save()} />
      <Show when={keys.some((key) => unreadable()[key])}>
        <NoticeCard tone="warning" title={g().unreadableTitle} detail={g().unreadableDetail}>
          <For each={keys.filter((key) => unreadable()[key])}>
            {(key) => (
              <Checkbox
                label={`${g().replaceStored}: ${label(key)}`}
                value={replace()[key] === true}
                onValueChange={(checked) => setReplace({ ...replace(), [key]: checked })}
                disabled={form.saving()}
              />
            )}
          </For>
        </NoticeCard>
      </Show>
      <TagsInput
        label={t().accessServers}
        value={() => form.draft().servers}
        onValueChange={(servers) => form.update({ servers })}
        disabled={disabled("servers")}
      />
      <Select
        label={t().accessKind}
        options={[
          { value: "creds", label: t().accessCreds },
          { value: "nkey", label: t().accessNkey },
        ]}
        value={() => form.draft().kind}
        onValueChange={(kind) => form.update({ kind: kind ?? "creds" })}
        disabled={disabled("kind")}
      />
      <Show when={form.draft().kind !== form.stored().kind && !form.draft().access && !form.draft().clear}>
        <NoticeCard tone="warning" title={t().accessSwitchHelp} />
      </Show>
      <TextInput
        label={t().accessSecret}
        description={
          <span class="grid">
            <span class="col-start-1 row-start-1" classList={{ invisible: showAccessMessage() }} aria-hidden={showAccessMessage()}>
              {t().accessSecretHelp}
            </span>
            <span
              id={accessHelpId}
              class="col-start-1 row-start-1"
              classList={{ invisible: !showAccessMessage() }}
              aria-hidden={!showAccessMessage()}
              aria-live="polite"
            >
              {form.errors().access || t().accessEndpointHelp}
            </span>
          </span>
        }
        externalErrorId={showAccessMessage() ? accessHelpId : undefined}
        multiline
        autocomplete="off"
        spellcheck={false}
        autocapitalize="off"
        autocorrect="off"
        value={() => form.draft().access}
        onValueChange={(access) => form.update({ access, clear: false })}
        error={() => form.errors().access}
        disabled={disabled("access") || form.draft().clear}
      />
      <Checkbox
        label={t().accessClear}
        value={form.draft().clear}
        onValueChange={(clear) => form.update({ clear, access: "" })}
        disabled={disabled("access")}
      />
      <TextInput
        label={t().accessCa}
        description={t().accessCaHelp}
        multiline
        autocomplete="off"
        value={() => form.draft().ca}
        onValueChange={(ca) => form.update({ ca })}
        disabled={disabled("ca")}
      />
    </div>
  );
}
