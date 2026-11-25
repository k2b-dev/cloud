import { apiClient } from "@k2b/cloud/clients/core";
import type { WebAuthnPasskey } from "@k2b/cloud/contracts";
import { dates } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { Button, confirm, Dialog, Empty, Field, Input, Notice, Row, Section, useToast } from "@k2b/ui/v2";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { createSignal, For, onMount, Show } from "solid-js";
import { useAccountMessages } from "./AccountWorkspace";
import { confirmIdentity, SignInNeededError, takeReturnIntent, throwIfSignInNeeded } from "./confirm-identity";

const ADD_INTENT = { key: "add", value: "passkey" };

/** Only a stable, machine-readable code reaches the person; server prose never does. */
const safeErrorCode = async (res: { status: number; json: () => Promise<unknown> }): Promise<string> => {
  const body = await res.json().catch(() => null);
  const code = body && typeof body === "object" && "code" in body ? body.code : null;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : `HTTP ${res.status}`;
};

/**
 * Security › Passkeys: the person's passkeys, adding one (named first, then the browser's registration) and deleting
 * one after a question. Adding needs a recent sign-in; after it the dialog opens again with the name entered.
 */
export default function PasskeysSection(props: {
  initialPasskeys: WebAuthnPasskey[];
  /** The time of the server's answer, so relative times read the same on the server and in the first paint. */
  now: string;
}) {
  const t = useAccountMessages();
  const locale = useLocale();
  const toast = useToast();
  const [passkeys, setPasskeys] = createSignal<WebAuthnPasskey[]>(props.initialPasskeys);
  const [open, setOpen] = createSignal(false);
  const [name, setName] = createSignal("");
  const [tried, setTried] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [deleting, setDeleting] = createSignal(false);
  const base = new Date(props.now);

  const openCreate = (initialName?: string) => {
    setName(initialName ?? "");
    setTried(false);
    setError(null);
    setOpen(true);
  };

  const create = async () => {
    setTried(true);
    const trimmed = name().trim();
    if (busy() || !trimmed) return;
    setBusy(true);
    setError(null);
    try {
      if (!browserSupportsWebAuthn()) throw new Error(t().passkeysUnsupported);
      const optionsRes = await apiClient.me.passkeys.registration.start.$post();
      await throwIfSignInNeeded(optionsRes.clone());
      const options = await optionsRes.json();
      if (!optionsRes.ok) throw new Error(t().passkeyRegistrationFailed);
      const response = await startRegistration({ optionsJSON: options as never });
      const verifyRes = await apiClient.me.passkeys.registration.verify.$post({ json: { name: trimmed, response } });
      await throwIfSignInNeeded(verifyRes.clone());
      const data = await verifyRes.json();
      if (!verifyRes.ok) throw new Error(t().passkeyAddFailed);
      setPasskeys([data as WebAuthnPasskey, ...passkeys()]);
      setOpen(false);
    } catch (cause) {
      if (cause instanceof SignInNeededError && cause.code === "REAUTHENTICATE") {
        setOpen(false);
        return confirmIdentity(
          t().passkeyReauthenticate,
          ADD_INTENT,
          { title: t().confirmIdentity, confirm: t().confirmIdentity },
          { name: trimmed },
        );
      }
      setError(
        cause instanceof SignInNeededError ? t().browserSignInRequired : cause instanceof Error ? cause.message : t().passkeyAddFailed,
      );
    } finally {
      setBusy(false);
    }
  };

  // Back from "Confirm identity": continue where the person started, with the name they entered.
  onMount(() => {
    const returned = takeReturnIntent(ADD_INTENT);
    if (!returned) return;
    const draft = returned.draft;
    openCreate(draft && typeof draft === "object" && "name" in draft && typeof draft.name === "string" ? draft.name : undefined);
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
  const remove = async (passkey: WebAuthnPasskey) => {
    const agreed = await confirm({
      title: t().deletePasskey,
      description: t().deletePasskeyConfirm({ name: passkey.name }),
      confirm: t().delete,
      cancel: t().cancel,
    });
    if (!agreed || deleting()) return;
    setDeleting(true);
    try {
      const res = await apiClient.me.passkeys[":id"].$delete({ param: { id: passkey.id } }).catch(() => null);
      if (!res) {
        // No response: the deletion may or may not have happened, so show the server's state.
        await reload();
        throw new Error(t().passkeyDeleteUnconfirmed);
      }
      // After a confirmed deletion the server's list is the truth; fall back to the local list offline.
      if (res.ok) {
        if (!(await reload())) dropLocally(passkey.id);
        return;
      }
      const code = await safeErrorCode(res);
      // The delete is owner-scoped, so 404 means this account has no such passkey (any more).
      if (res.status === 404 && !(await reload())) dropLocally(passkey.id);
      throw new Error(`${deleteFailure(res.status)} ${t().errorCode({ code })}`);
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : t().passkeyDeleteFailed, { status: "bad" });
    } finally {
      setDeleting(false);
    }
  };

  const line = (passkey: WebAuthnPasskey) =>
    [
      t().created({ date: dates.formatDate(passkey.createdAt, { locale: locale() }) }),
      passkey.lastUsedAt ? t().used({ date: dates.formatDateTimeRelative(passkey.lastUsedAt, { locale: locale(), base }) }) : t().neverUsed,
      ...(passkey.transports.length > 0 ? [passkey.transports.join(", ")] : []),
    ].join(" · ");

  return (
    <>
      <Section
        icon="fingerprint"
        title={t().passkeys}
        count={passkeys().length}
        summary={t().passkeysDescription}
        actions={[{ label: t().add, icon: "plus", disabled: busy(), onClick: () => openCreate() }]}
      >
        <Show
          when={passkeys().length > 0}
          fallback={
            <Empty icon="fingerprint" text={t().noPasskeys} action={{ label: t().addPasskey, icon: "plus", onClick: () => openCreate() }} />
          }
        >
          <For each={passkeys()}>
            {(passkey) => (
              <Row
                icon="fingerprint"
                lines={[passkey.name, line(passkey)]}
                meta={passkey.backedUp ? t().synced : undefined}
                end={
                  <Button
                    variant="ghost"
                    icon="trash"
                    label={t().deleteNamedPasskey({ name: passkey.name })}
                    disabled={deleting()}
                    onClick={() => void remove(passkey)}
                  />
                }
              />
            )}
          </For>
        </Show>
      </Section>
      <Dialog
        title={t().addPasskey}
        open={open()}
        onOpenChange={(next) => !busy() && setOpen(next)}
        foot={
          <>
            <Button disabled={busy()} onClick={() => setOpen(false)}>
              {t().cancel}
            </Button>
            <Button variant="primary" icon="fingerprint" busy={busy()} onClick={() => void create()}>
              {t().addPasskey}
            </Button>
          </>
        }
      >
        <Field
          name="name"
          label={t().name}
          hint={t().passkeyNameDescription}
          error={tried() && !name().trim() ? t().passkeyNameRequired : undefined}
          required
        >
          <Input
            value={name()}
            onInput={setName}
            placeholder={t().passkeyNamePlaceholder}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.isComposing) void create();
            }}
          />
        </Field>
        <Show when={error()}>{(message) => <Notice tone="bad">{message()}</Notice>}</Show>
      </Dialog>
    </>
  );
}
