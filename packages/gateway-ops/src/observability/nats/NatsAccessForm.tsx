import { createSettingsDraft, saveFailure } from "@k2b/cloud/ssr/settings-draft";
import { useLocale } from "@k2b/ui";
import { Band, Check, Choice, Field, Input, Notice } from "@k2b/ui/v2";
import { createSignal, For, Show } from "solid-js";
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

/** One server per line; blank lines and surrounding spaces do not count. */
const serverList = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * The diagnostics access fields. The draft registers with `settingsSaveControls`, so the screen's head saves and
 * discards; only changed fields are written, and the access secret last.
 */
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
  // The servers field keeps what the person typed, blank lines included; the draft holds the list it means.
  const [serversText, setServersText] = createSignal(props.values.servers.join("\n"));
  const disabled = (key: Key) => form.saving() || (unreadable()[key] && !replace()[key]);
  const outcome = () => form.outcome();
  return (
    <>
      <Show when={outcome()}>
        {(failed) =>
          failed().kind === "failed" ? (
            <Notice tone="bad" title={t().notSaved} actions={[{ label: t().retry, icon: "refresh", onClick: () => void form.save() }]}>
              {failed().message} {t().notSavedKeep}
            </Notice>
          ) : (
            <Notice
              tone="warn"
              title={t().unknownOutcome}
              actions={[{ label: t().checkNow, icon: "refresh", onClick: () => window.location.reload() }]}
            >
              {t().unknownOutcomeKeep}
            </Notice>
          )
        }
      </Show>
      <Show when={keys.some((key) => unreadable()[key])}>
        <Notice tone="warn" title={g().unreadableTitle}>
          {g().unreadableDetail}
        </Notice>
        <Band>
          <For each={keys.filter((key) => unreadable()[key])}>
            {(key) => (
              <Check
                label={`${g().replaceStored}: ${label(key)}`}
                checked={replace()[key] === true}
                onChange={(checked) => setReplace({ ...replace(), [key]: checked })}
                disabled={form.saving()}
              />
            )}
          </For>
        </Band>
      </Show>
      <Band>
        <Field label={t().accessServers} hint={t().accessServersHint}>
          {/* k2b-ui gap: a tags input (one chip per value); until then one server per line */}
          <Input
            multiline
            value={serversText()}
            disabled={disabled("servers")}
            onInput={(text) => {
              setServersText(text);
              form.update({ servers: serverList(text) });
            }}
          />
        </Field>
        <Field label={t().accessKind}>
          <Choice
            name="kind"
            options={[
              { value: "creds", label: t().accessCreds },
              { value: "nkey", label: t().accessNkey },
            ]}
            value={form.draft().kind}
            onChange={(kind) => form.update({ kind })}
            disabled={disabled("kind")}
          />
        </Field>
      </Band>
      <Show when={form.draft().kind !== form.stored().kind && !form.draft().access && !form.draft().clear}>
        <Notice tone="warn" title={t().accessKind}>
          {t().accessSwitchHelp}
        </Notice>
      </Show>
      <Band>
        <Field
          label={t().accessSecret}
          hint={serversChanged(form.draft()) || accessRequired() ? t().accessEndpointHelp : t().accessSecretHelp}
          error={form.errors().access}
        >
          {/* k2b-ui gap: Input has no spellcheck/autocomplete; a secret must never reach a spellchecker or autofill */}
          <Input
            multiline
            ref={(element) => {
              element.spellcheck = false;
              element.autocomplete = "off";
            }}
            value={form.draft().access}
            onInput={(access) => form.update({ access, clear: false })}
            disabled={disabled("access") || form.draft().clear}
          />
        </Field>
        <Check
          label={t().accessClear}
          checked={form.draft().clear}
          onChange={(clear) => form.update({ clear, access: "" })}
          disabled={disabled("access")}
        />
        <Field label={t().accessCa} hint={t().accessCaHelp} optional={t().optional}>
          <Input multiline value={form.draft().ca} onInput={(ca) => form.update({ ca })} disabled={disabled("ca")} />
        </Field>
      </Band>
    </>
  );
}
