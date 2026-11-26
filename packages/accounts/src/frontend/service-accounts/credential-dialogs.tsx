import { coreClient } from "@k2b/cloud/clients/core";
import { Button, Chip, Dialog, Facts, Notice, Text, useToast } from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import { z } from "zod";
import { apiClient } from "@/api/client";
import { type AccountsMessages, useAccountsMessages } from "../messages";
import type { AccountKey, ApiKeyRow } from "./api-key-row";
import { type ApiKeyMessages, useApiKeyMessages } from "./messages";

/** Revokes one key through the Accounts API; a refusal carries the server's sentence, anything else `fallback`. */
export const revokeCredential = async (credentialId: string, fallback: string): Promise<void> => {
  const response = await apiClient["service-accounts"].credentials[":id"].$delete({ param: { id: credentialId } }).catch(() => null);
  if (response?.ok) return;
  const body = z.object({ message: z.string() }).safeParse(await response?.json().catch(() => null));
  throw new Error(body.success ? body.data.message : fallback);
};

export const kindLabel = (t: AccountsMessages, kind: ApiKeyRow["kind"]) =>
  kind === "user_delegated" ? t.userBound : kind === "agent" ? t.agent : t.resourceBound;

export const accessLabel = (t: AccountsMessages, access: AccountKey["access"]) =>
  access === "models" ? t.modelsOnlyKey : access === "legacy" ? t.legacyLimitedKey : t.fullKeyAccess;

/**
 * The mark of a key: its purpose in its colour (full access, AI models only, an agent's legacy key); a key that works
 * no more keeps the symbol of a closed key in the colour of its state.
 */
export const keyMark = (entry: AccountKey): { icon: string; color: string } =>
  !entry.active
    ? { icon: "key-off", color: "#dc2626" }
    : entry.expired
      ? { icon: "key-off", color: "#d97706" }
      : entry.access === "models"
        ? { icon: "sparkles", color: "#7c3aed" }
        : entry.access === "legacy"
          ? { icon: "lock", color: "#b45309" }
          : { icon: "key", color: "#2563eb" };

export const ownerName = (t: AccountsMessages, row: ApiKeyRow) => row.owner.name || t.resource;

export const statusChip = (t: AccountsMessages, row: AccountKey) =>
  row.active ? <Chip status="ok">{t.active}</Chip> : <Chip status="bad">{t.revoked}</Chip>;

/**
 * One key opened from the list (on the phone the only way to its deeds): its facts, and "Replace" and "Revoke" while
 * it is active. A deed closes this dialog first and opens its own, so no dialog stands on another.
 */
export function KeyDialog<K extends AccountKey & Partial<Pick<ApiKeyRow, "kind" | "owner">>>(props: {
  entry: K | null;
  close: () => void;
  revoke: (entry: K) => void;
  replace: (entry: K, serviceAccountId: string) => void;
}) {
  const t = useAccountsMessages();
  const words = useApiKeyMessages();
  return (
    <Show when={props.entry}>
      {(entry) => (
        <Dialog
          title={words().keyOf({ name: entry().name })}
          open
          onOpenChange={(open) => {
            if (!open) props.close();
          }}
          foot={
            <Show when={entry().active} fallback={<Button onClick={props.close}>{t().close}</Button>}>
              <Show when={entry().replace}>
                {(target) => (
                  <Button icon="replace" onClick={() => props.replace(entry(), target().serviceAccountId)}>
                    {t().replaceKey}
                  </Button>
                )}
              </Show>
              <Button icon="key-off" onClick={() => props.revoke(entry())}>
                {t().revoke}
              </Button>
            </Show>
          }
        >
          <Facts
            items={[
              ...owned(t(), entry()),
              { label: words().access, value: accessLabel(t(), entry().access) },
              { label: words().prefix, value: entry().prefix, mono: true },
              { label: t().status, value: statusChip(t(), entry()) },
              { label: t().created, value: entry().created },
              { label: t().lastUsed, value: entry().lastUsed ?? words().neverUsed },
              { label: t().expires, value: entry().expires ?? words().never },
            ]}
          />
          <Show when={entry().access === "legacy"}>
            <Notice tone="note">{t().legacyLimitedKeyHint}</Notice>
          </Show>
        </Dialog>
      )}
    </Show>
  );
}

/** The owner and kind of a key in the list of all keys; an account's record names neither again. */
const owned = (t: AccountsMessages, entry: AccountKey & Partial<Pick<ApiKeyRow, "kind" | "owner">>) => {
  const { kind, owner } = entry;
  return kind && owner
    ? [
        { label: t.owner, value: owner.name || t.resource },
        { label: t.type, value: kindLabel(t, kind) },
      ]
    : [];
};

/** The one question before a key is revoked; it resolves whether the key is gone. */
export const confirmRevoke = async (t: AccountsMessages, words: ApiKeyMessages, entry: AccountKey) =>
  Dialog.confirm({
    title: words.revokeTitle({ name: entry.name }),
    description: words.revokeConsequence,
    confirm: t.revoke,
    cancel: t.cancel,
  });

const CreatedSchema = z.object({ token: z.string().min(1) });

/**
 * Replacing an agent's legacy key: the new key is created first and shown once; the old key is revoked only on an
 * explicit press. Closing earlier keeps both keys, so a program that still uses the old one never stops by surprise.
 */
export function ReplaceKeyDialog(props: {
  name: string;
  serviceAccountId: string;
  credentialId: string;
  /** `changed` when a key was created, may have been, or the old one was revoked: the list must be read again. */
  close: (changed: boolean) => void;
}) {
  const t = useAccountsMessages();
  const toast = useToast();
  const [token, setToken] = createSignal<string | null>(null);
  // A lost answer may follow a created key: never offer a second creation, and let the list show what exists.
  const [uncertain, setUncertain] = createSignal(false);
  const [creating, setCreating] = createSignal(false);
  const [revoking, setRevoking] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const busy = () => creating() || revoking();

  const create = async () => {
    if (busy() || uncertain() || token()) return;
    setCreating(true);
    setError(null);
    try {
      const response = await coreClient.admin.identity["service-accounts"][":id"]["api-keys"]
        .$post({ param: { id: props.serviceAccountId }, json: { name: props.name, access: "full", expiresAt: null } })
        .catch(() => null);
      const body: unknown = await response?.json().catch(() => null);
      if (response && !response.ok && response.status < 500) {
        const refused = z.object({ message: z.string() }).safeParse(body);
        setError(refused.success ? refused.data.message : t().replaceKeyFailed);
        return;
      }
      const created = CreatedSchema.safeParse(response?.ok ? body : null);
      if (!created.success) {
        setUncertain(true);
        setError(t().replaceKeyUncertain);
        return;
      }
      setToken(created.data.token);
      toast(t().replaceKeyCreated, { status: "ok" });
      // The create button leaves; the focus goes to the copy button of the new key.
      queueMicrotask(() =>
        document.querySelector<HTMLButtonElement>('[data-k2-part="Dialog"] [data-k2-part="Facts"] button')?.focus({ preventScroll: true }),
      );
    } finally {
      setCreating(false);
    }
  };
  const revokeOld = async () => {
    if (busy()) return;
    setRevoking(true);
    setError(null);
    try {
      await revokeCredential(props.credentialId, t().revokeApiKeyFailed);
      props.close(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t().revokeApiKeyFailed);
    } finally {
      setRevoking(false);
    }
  };
  const close = () => {
    if (!busy()) props.close(token() !== null || uncertain());
  };

  return (
    <Dialog
      title={t().replaceKeyTitle({ name: props.name })}
      open
      // While the new key shows, a stray press outside would lose its one copy: only the buttons, × and Escape close.
      dismissible={token() === null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      foot={
        <Show
          when={token()}
          fallback={
            <>
              <Button onClick={close} disabled={creating()}>
                {t().cancel}
              </Button>
              <Button variant="primary" icon="key" busy={creating()} disabled={uncertain()} onClick={() => void create()}>
                {t().replaceKeyCreate}
              </Button>
            </>
          }
        >
          <Button onClick={() => props.close(true)} disabled={revoking()}>
            {t().replaceKeyLater}
          </Button>
          <Button variant="primary" icon="key-off" busy={revoking()} onClick={() => void revokeOld()}>
            {t().replaceKeyRevokeOld}
          </Button>
        </Show>
      }
    >
      <Text>{t().replaceKeyIntro}</Text>
      <Show when={token()}>
        {(value) => (
          <>
            <Notice tone="warn" icon="key">
              {t().machineKeyOneTime}
            </Notice>
            <Facts items={[{ label: t().apiKey, value: value(), copy: value(), mono: true }]} />
          </>
        )}
      </Show>
      <Show when={error()}>{(message) => <Notice tone="bad">{message()}</Notice>}</Show>
    </Dialog>
  );
}
