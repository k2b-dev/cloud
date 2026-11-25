import { Empty, Failed, Menu, type MenuItem, Notice, Row, Section, useToast } from "@k2b/ui/v2";
import { createSignal, For, Show } from "solid-js";
import { usePageSwap } from "../lib/page-swap";
import { useAccountsMessages } from "../messages";
import type { AccountKey } from "./api-key-row";
import { accessLabel, confirmRevoke, KeyDialog, ReplaceKeyDialog, revokeCredential } from "./credential-dialogs";
import MachineKeyDialog from "./MachineKeyDialog";
import { useApiKeyMessages } from "./messages";

/** The account an API key section belongs to, as the record's server passes it. */
export type KeyAccount = {
  id: string;
  name: string;
  /** Only an agent gets new keys here (and replaces its legacy ones); the other kinds' keys come from their owner. */
  kind: "agent" | "resource_bound" | "user_delegated";
  active: boolean;
};

export type ApiKeysSectionProps = {
  account: KeyAccount;
  /** The account's active keys, newest first, from `toAccountKey`; null when they could not be read. */
  keys: readonly AccountKey[] | null;
  /** How many active keys the account has; the section lists the service's first page of them. */
  total: number;
  /** Whether the OpenAI-compatible API is on, so a key may be limited to AI models. */
  modelsAvailable: boolean;
  /** The person's time zone: a key's last day ends at midnight there. */
  timeZone: string;
};

type Replacing = { name: string; serviceAccountId: string; credentialId: string };

/**
 * An account's API keys, as a section of its record: one row per active key with its prefix, purpose and last use. A
 * row opens the key's facts; "…" and the open key revoke it, and an agent's legacy key is replaced by a new one. An
 * active agent gets a new key here; its token shows once, in the dialog. After every change the record is read again.
 */
export default function ApiKeysSection(props: ApiKeysSectionProps) {
  const t = useAccountsMessages();
  const words = useApiKeyMessages();
  const toast = useToast();
  const { showChanges } = usePageSwap();
  const [creating, setCreating] = createSignal(false);
  const [opened, setOpened] = createSignal<AccountKey | null>(null);
  const [replacing, setReplacing] = createSignal<Replacing | null>(null);
  const creatable = () => props.account.kind === "agent" && props.account.active;
  const create = { label: t().createMachineKey, icon: "plus", onClick: () => setCreating(true) };

  const revoke = async (entry: AccountKey) => {
    setOpened(null);
    if (!(await confirmRevoke(t(), words(), entry))) return;
    try {
      await revokeCredential(entry.id, t().revokeApiKeyFailed);
      toast(words().revoked_({ name: entry.name }), { status: "ok" });
      await showChanges();
    } catch (failure) {
      toast(failure instanceof Error ? failure.message : t().revokeApiKeyFailed, { status: "bad" });
    }
  };
  const replace = (entry: AccountKey, serviceAccountId: string) => {
    setOpened(null);
    setReplacing({ name: entry.name, serviceAccountId, credentialId: entry.id });
  };
  const deeds = (entry: AccountKey): MenuItem[] => [
    ...(entry.replace ? [{ label: t().replaceKey, icon: "replace", onClick: () => replace(entry, entry.replace!.serviceAccountId) }] : []),
    { label: t().revoke, icon: "key-off", danger: true, onClick: () => void revoke(entry) },
  ];
  const second = (entry: AccountKey) =>
    words().keyLine({
      prefix: entry.prefix,
      access: accessLabel(t(), entry.access),
      used: entry.expired
        ? words().expiredOn({ when: entry.expires ?? "" })
        : entry.lastUsed
          ? words().usedOn({ when: entry.lastUsed })
          : words().neverUsed,
    });

  return (
    <>
      <Section
        title={words().keysTitle}
        icon="key"
        count={props.keys ? props.total : undefined}
        actions={creatable() ? [create] : undefined}
      >
        <Show when={props.account.kind === "agent" && !props.account.active}>
          <Notice tone="warn">{words().agentInactive}</Notice>
        </Show>
        <Show when={props.keys?.some((entry) => entry.access === "legacy")}>
          <Notice tone="note" icon="lock" title={t().legacyLimitedKey}>
            {t().legacyLimitedKeyHint}
          </Notice>
        </Show>
        <Show when={props.keys} fallback={<Failed text={words().keysFailed} onRetry={() => void showChanges()} />}>
          {(keys) => (
            <Show when={keys().length} fallback={<Empty icon="key" text={words().keysEmpty} action={creatable() ? create : undefined} />}>
              <For each={keys()}>
                {(entry) => (
                  <Row
                    lines={[entry.name, second(entry)]}
                    icon={entry.expired ? "key-off" : "key"}
                    onOpen={() => setOpened(entry)}
                    end={<Menu label={words().keyActions({ name: entry.name })} items={deeds(entry)} />}
                  />
                )}
              </For>
            </Show>
          )}
        </Show>
      </Section>
      <Show when={creating()}>
        <MachineKeyDialog
          account={props.account}
          modelsAvailable={props.modelsAvailable}
          timeZone={props.timeZone}
          close={(changed) => {
            setCreating(false);
            if (changed) void showChanges();
          }}
        />
      </Show>
      <KeyDialog entry={opened()} close={() => setOpened(null)} revoke={(entry) => void revoke(entry)} replace={replace} />
      <Show when={replacing()}>
        {(target) => (
          <ReplaceKeyDialog
            name={target().name}
            serviceAccountId={target().serviceAccountId}
            credentialId={target().credentialId}
            close={(changed) => {
              setReplacing(null);
              if (changed) void showChanges();
            }}
          />
        )}
      </Show>
    </>
  );
}
