import { apiClient } from "@k2b/cloud/clients/core";
import type { WebAuthnPasskey } from "@k2b/cloud/contracts";
import { dates } from "@k2b/stdlib";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, Placeholder, prompts, SettingsSection, TextInput, useLocale } from "@k2b/ui";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { createSignal, For, onMount, Show } from "solid-js";
import { confirmIdentity, SignInNeededError, takeReturnIntent, throwIfSignInNeeded } from "./confirm-identity";
import { accountMessages } from "./messages";

const ADD_INTENT = { key: "add", value: "passkey" };

/** Only a stable, machine-readable code reaches the dialog; server prose never does. */
const safeErrorCode = async (res: { status: number; json: () => Promise<unknown> }): Promise<string> => {
  const body = await res.json().catch(() => null);
  const code = body && typeof body === "object" && "code" in body ? body.code : null;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : `HTTP ${res.status}`;
};

type Props = {
  initialPasskeys: WebAuthnPasskey[];
};

function PasskeyCreateDialog(props: { initialName?: string; close: (value: { name: string } | null) => void }) {
  const locale = useLocale();
  const t = () => accountMessages.resolve([locale()]).t;
  const [name, setName] = createSignal(props.initialName ?? "");
  const [error, setError] = createSignal<string | undefined>();

  const submit = () => {
    const trimmedName = name().trim();
    if (!trimmedName) {
      setError(t().passkeyNameRequired);
      return;
    }
    props.close({ name: trimmedName });
  };

  return (
    <form
      class="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <TextInput
        label={t().name}
        description={t().passkeyNameDescription}
        placeholder={t().passkeyNamePlaceholder}
        icon="ti ti-tag"
        value={name}
        onValueChange={(value) => {
          setName(value);
          setError(undefined);
        }}
        error={error}
        required
      />
      <div class="flex justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => props.close(null)}>
          {t().cancel}
        </Button>
        <Button type="submit" size="sm">
          <i class="ti ti-fingerprint" />
          {t().addPasskey}
        </Button>
      </div>
    </form>
  );
}

export default function PasskeysSettings(props: Props) {
  const locale = useLocale();
  const t = () => accountMessages.resolve([locale()]).t;
  const [passkeys, setPasskeys] = createSignal<WebAuthnPasskey[]>(props.initialPasskeys);
  let submittedName: string | undefined;

  const createMutation = mutations.create<WebAuthnPasskey, { name: string }>({
    mutation: async (vars) => {
      if (!browserSupportsWebAuthn()) throw new Error(t().passkeysUnsupported);
      const optionsRes = await apiClient.me.passkeys.registration.start.$post();
      await throwIfSignInNeeded(optionsRes.clone());
      const options = await optionsRes.json();
      if (!optionsRes.ok) throw new Error(t().passkeyRegistrationFailed);

      const response = await startRegistration({ optionsJSON: options as never });
      const verifyRes = await apiClient.me.passkeys.registration.verify.$post({
        json: { name: vars.name, response },
      });
      await throwIfSignInNeeded(verifyRes.clone());
      const data = await verifyRes.json();
      if (!verifyRes.ok) throw new Error(t().passkeyAddFailed);
      return data as WebAuthnPasskey;
    },
    onSuccess: (passkey) => {
      setPasskeys([passkey, ...passkeys()]);
    },
    onError: async (err) => {
      if (err instanceof SignInNeededError && err.code === "REAUTHENTICATE")
        return confirmIdentity(
          t().passkeyReauthenticate,
          ADD_INTENT,
          { title: t().confirmIdentity, confirm: t().confirmIdentity },
          submittedName === undefined ? undefined : { name: submittedName },
        );
      prompts.error(err instanceof SignInNeededError ? t().browserSignInRequired : err.message);
    },
  });

  /** Reloads the list from the server; keeps the current list when the reload itself fails. */
  const reload = async (): Promise<boolean> => {
    try {
      const res = await apiClient.me.passkeys.$get();
      if (!res.ok) return false;
      setPasskeys((await res.json()).items);
      return true;
    } catch {
      return false;
    }
  };

  const dropLocally = (id: string) => setPasskeys(passkeys().filter((passkey) => passkey.id !== id));

  const deleteFailure = (status: number): string => {
    if (status === 401) return t().passkeyDeleteSessionExpired;
    if (status === 403) return t().passkeyDeleteForbidden;
    if (status === 404) return t().passkeyDeleteNotFound;
    return t().passkeyDeleteFailed;
  };

  const deleteMutation = mutations.create<void, { id: string; name: string }>({
    mutation: async (vars) => {
      const res = await apiClient.me.passkeys[":id"].$delete({ param: { id: vars.id } }).catch(() => null);
      if (!res) {
        // No response: the deletion may or may not have happened, so show the server's state.
        await reload();
        throw new Error(t().passkeyDeleteUnconfirmed);
      }
      // After a confirmed deletion the server's list is the truth; fall back to the local list offline.
      if (res.ok) {
        if (!(await reload())) dropLocally(vars.id);
        return;
      }
      const code = await safeErrorCode(res);
      // The delete is owner-scoped, so 404 means this account has no such passkey (any more).
      if (res.status === 404 && !(await reload())) dropLocally(vars.id);
      throw new Error(`${deleteFailure(res.status)} ${t().errorCode({ code })}`);
    },
    onError: (err) => prompts.error(err.message),
  });

  const openCreate = async (initialName?: string) => {
    const result = await prompts.dialog<{ name: string } | null>(
      (close) => <PasskeyCreateDialog initialName={initialName} close={close} />,
      { title: t().addPasskey, icon: "ti ti-fingerprint", size: "medium" },
    );
    if (!result) return;
    submittedName = result.name;
    await createMutation.mutate(result);
  };

  // Back from "Confirm identity": continue where the person started, with the name they entered.
  onMount(() => {
    const returned = takeReturnIntent(ADD_INTENT);
    if (!returned) return;
    const draft = returned.draft;
    void openCreate(draft && typeof draft === "object" && "name" in draft && typeof draft.name === "string" ? draft.name : undefined);
  });

  const remove = async (passkey: WebAuthnPasskey) => {
    const confirmed = await prompts.confirm(t().deletePasskeyConfirm({ name: passkey.name }), {
      title: t().deletePasskey,
      icon: "ti ti-fingerprint-off",
      variant: "danger",
      confirmText: t().delete,
    });
    if (confirmed) await deleteMutation.mutate({ id: passkey.id, name: passkey.name });
  };

  return (
    <SettingsSection
      title={t().passkeys}
      subtitle={t().passkeysDescription}
      actions={
        <Button type="button" variant="secondary" size="sm" onClick={() => void openCreate()} disabled={createMutation.loading()}>
          <i class="ti ti-plus" aria-hidden="true" />
          {t().add}
        </Button>
      }
    >
      <Show when={passkeys().length > 0} fallback={<Placeholder icon="ti ti-fingerprint" description={<>{t().noPasskeys}</>} />}>
        <div class="flex flex-col gap-1 rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-subtle)] p-2">
          <For each={passkeys()}>
            {(passkey) => (
              <div class="flex items-center gap-3 p-3">
                <div class="min-w-0 flex-1">
                  <div class="flex min-w-0 items-center gap-2">
                    <span class="truncate text-sm font-medium text-primary">{passkey.name}</span>
                    {passkey.backedUp && (
                      <span class="tag bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300">{t().synced}</span>
                    )}
                  </div>
                  <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-dimmed">
                    <span>{t().created({ date: dates.formatDate(passkey.createdAt, { locale: locale() }) })}</span>
                    <span>
                      {passkey.lastUsedAt
                        ? t().used({ date: dates.formatDateTimeRelative(passkey.lastUsedAt, { locale: locale() }) })
                        : t().neverUsed}
                    </span>
                    {passkey.transports.length > 0 && <span>{passkey.transports.join(", ")}</span>}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  class="shrink-0 text-red-600 dark:text-red-400"
                  disabled={deleteMutation.loading()}
                  onClick={() => remove(passkey)}
                >
                  <i class="ti ti-trash" />
                  {t().delete}
                </Button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </SettingsSection>
  );
}
