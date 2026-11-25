import { apiClient } from "@k2b/cloud/clients/core";
import { isModelsOnlyApiKey, type ServiceAccountCredential } from "@k2b/cloud/contracts";
import { dates } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { Button, Choice, confirm, Dialog, Empty, Facts, Field, Input, Notice, Row, Section, Select, useToast } from "@k2b/ui/v2";
import { createSignal, For, type JSX, onMount, Show } from "solid-js";
import { useAccountMessages } from "./AccountWorkspace";
import { confirmIdentity, SignInNeededError, takeReturnIntent, throwIfSignInNeeded } from "./confirm-identity";
import { useConnectSetup } from "./connect-setup";

const CREATE_INTENT = { key: "create", value: "api-key" };

type ApiKeyAccess = "full" | "models";
type ApiKeyDraft = { name: string; expiresAt: string | null; access?: ApiKeyAccess };
/** How long a new key lives, in days; "never" for long-lived automation. */
const EXPIRY_CHOICES = ["30", "90", "365", "never"] as const;
type Expiry = (typeof EXPIRY_CHOICES)[number];

const expiryInstant = (choice: Expiry, now = Date.now()) =>
  choice === "never" ? null : new Date(now + Number(choice) * 24 * 60 * 60 * 1000).toISOString();

/** A draft restored after "Confirm identity"; anything else opens the dialog with its defaults. */
const readApiKeyDraft = (value: unknown): { name: string; access?: ApiKeyAccess; never: boolean } | null => {
  if (!value || typeof value !== "object") return null;
  const name = "name" in value ? value.name : undefined;
  const expiresAt = "expiresAt" in value ? value.expiresAt : undefined;
  const access = "access" in value ? value.access : undefined;
  if (typeof name !== "string" || (expiresAt !== null && typeof expiresAt !== "string")) return null;
  return { name, never: expiresAt === null, ...(access === "full" || access === "models" ? { access } : {}) };
};

/**
 * Security & devices › API keys: the person's delegated keys, a new key (its token shown once in the dialog) and revoking one.
 * Creating needs a recent sign-in; after it the dialog opens again with what was entered. `primary` opens the dialog
 * from the page's head; `dialogs` must stand once in the screen.
 */
export const useApiKeys = (props: {
  initialKeys: ServiceAccountCredential[];
  openAiBaseUrl: string | null;
  now: string;
  /** Where the CLI and agents connect, for the set-up behind the section deed. */
  connect: { mcpEndpoint: string; cloudUrl: string };
}) => {
  const t = useAccountMessages();
  const locale = useLocale();
  const toast = useToast();
  const base = new Date(props.now);
  const modelsAvailable = props.openAiBaseUrl !== null;
  const connect = useConnectSetup(props.connect);
  const [keys, setKeys] = createSignal<ServiceAccountCredential[]>(props.initialKeys);
  const [open, setOpen] = createSignal(false);
  const [name, setName] = createSignal("");
  const [access, setAccess] = createSignal<ApiKeyAccess>("full");
  const [expiry, setExpiry] = createSignal<Expiry>("90");
  const [tried, setTried] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [created, setCreated] = createSignal<{ token: string; baseUrl: string | null } | null>(null);
  const [revoking, setRevoking] = createSignal<string | null>(null);

  const openCreate = (draft?: ReturnType<typeof readApiKeyDraft>) => {
    setName(draft?.name ?? "");
    setAccess(draft?.access ?? "full");
    setExpiry(draft?.never ? "never" : "90");
    setTried(false);
    setError(null);
    setCreated(null);
    setOpen(true);
  };

  const create = async () => {
    setTried(true);
    const trimmed = name().trim();
    if (busy() || !trimmed) return;
    const draft: ApiKeyDraft = { name: trimmed, expiresAt: expiryInstant(expiry()), ...(modelsAvailable ? { access: access() } : {}) };
    setBusy(true);
    setError(null);
    try {
      const res = await apiClient.me["api-keys"].$post({ json: draft });
      await throwIfSignInNeeded(res.clone());
      const data = await res.json();
      if (!res.ok) throw new Error(t().apiKeyCreateFailed);
      const result = data as { credential: ServiceAccountCredential; token: string };
      setKeys([result.credential, ...keys()]);
      setCreated({ token: result.token, baseUrl: isModelsOnlyApiKey(result.credential) ? props.openAiBaseUrl : null });
    } catch (cause) {
      if (cause instanceof SignInNeededError && cause.code === "REAUTHENTICATE") {
        setOpen(false);
        return confirmIdentity(
          t().apiKeyReauthenticate,
          CREATE_INTENT,
          { title: t().confirmIdentity, confirm: t().confirmIdentity },
          draft,
        );
      }
      setError(
        cause instanceof SignInNeededError ? t().browserSignInRequired : cause instanceof Error ? cause.message : t().apiKeyCreateFailed,
      );
    } finally {
      setBusy(false);
    }
  };

  // Back from "Confirm identity": continue where the person started, with what they entered.
  onMount(() => {
    const returned = takeReturnIntent(CREATE_INTENT);
    if (returned) openCreate(readApiKeyDraft(returned.draft));
  });

  const revoke = async (key: ServiceAccountCredential) => {
    const agreed = await confirm({
      title: t().revokeApiKey,
      description: t().revokeApiKeyConfirm({ name: key.name }),
      confirm: t().revoke,
      cancel: t().cancel,
    });
    if (!agreed || revoking()) return;
    setRevoking(key.id);
    const res = await apiClient.me["api-keys"][":id"].$delete({ param: { id: key.id } }).catch(() => null);
    setRevoking(null);
    if (!res?.ok) return toast(t().apiKeyRevokeFailed, { status: "bad" });
    setKeys(keys().filter((entry) => entry.id !== key.id));
  };

  const line = (key: ServiceAccountCredential) =>
    [
      `${key.tokenPrefix}…`,
      ...(isModelsOnlyApiKey(key) ? [t().modelsOnly] : []),
      key.expiresAt ? t().expiresOn({ date: dates.formatDate(key.expiresAt, { locale: locale() }) }) : t().neverExpires,
      key.lastUsedAt ? t().used({ date: dates.formatDateTimeRelative(key.lastUsedAt, { locale: locale(), base }) }) : t().neverUsed,
    ].join(" · ");

  const section = (): JSX.Element => (
    <Section
      icon="key"
      title={t().apiKeys}
      count={keys().length}
      summary={t().apiKeysDescription}
      actions={[
        { label: t().createApiKey, icon: "plus", onClick: () => openCreate() },
        { label: t().connectAction, icon: "plug-connected", onClick: connect.open },
      ]}
    >
      <Show
        when={keys().length > 0}
        fallback={<Empty icon="key" text={t().noApiKeys} action={{ label: t().createApiKey, icon: "plus", onClick: () => openCreate() }} />}
      >
        <For each={keys()}>
          {(key) => (
            <Row
              icon={isModelsOnlyApiKey(key) ? "sparkles" : "key"}
              lines={[key.name, line(key)]}
              end={
                <Button
                  variant="ghost"
                  icon="key-off"
                  label={t().revokeNamedApiKey({ name: key.name })}
                  busy={revoking() === key.id}
                  onClick={() => void revoke(key)}
                />
              }
            />
          )}
        </For>
      </Show>
    </Section>
  );

  const dialogs = (): JSX.Element => (
    <>
    {connect.dialog()}
    <Dialog
      title={created() ? t().apiKeyCreated : t().createApiKey}
      open={open()}
      // While the token shows, a stray press outside would lose the one copy: only Done, × and Escape close.
      dismissible={created() === null}
      onOpenChange={(next) => !busy() && setOpen(next)}
      foot={
        <Show
          when={created()}
          fallback={
            <>
              <Button disabled={busy()} onClick={() => setOpen(false)}>
                {t().cancel}
              </Button>
              <Button variant="primary" icon="plus" busy={busy()} onClick={() => void create()}>
                {t().createKey}
              </Button>
            </>
          }
        >
          <Button variant="primary" onClick={() => setOpen(false)}>
            {t().done}
          </Button>
        </Show>
      }
    >
      <Show
        when={created()}
        fallback={
          <>
            <Field
              name="name"
              label={t().name}
              hint={t().apiKeyNameDescription}
              error={tried() && !name().trim() ? t().passkeyNameRequired : undefined}
              required
            >
              <Input value={name()} onInput={setName} placeholder={t().apiKeyNamePlaceholder} />
            </Field>
            <Show when={modelsAvailable}>
              <Field
                name="access"
                label={t().keyAccess}
                hint={access() === "models" ? t().modelsOnlyDescription : t().fullAccessDescription}
              >
                <Choice
                  name="access"
                  value={access()}
                  onChange={(value) => setAccess(value === "models" ? "models" : "full")}
                  options={[
                    { value: "full", label: t().fullAccess },
                    { value: "models", label: t().modelsOnly },
                  ]}
                />
              </Field>
            </Show>
            {/* k2b-ui gap: no date picker yet; a key lives for one of the preset spans or forever. */}
            <Field name="expires" label={t().expires} hint={t().apiKeyExpiryDescription}>
              <Select
                value={expiry()}
                onChange={(value) => setExpiry(EXPIRY_CHOICES.find((choice) => choice === value) ?? "90")}
                options={[
                  { value: "30", label: t().days30 },
                  { value: "90", label: t().days90 },
                  { value: "365", label: t().year1 },
                  { value: "never", label: t().never },
                ]}
              />
            </Field>
            <Show when={error()}>{(message) => <Notice tone="bad">{message()}</Notice>}</Show>
          </>
        }
      >
        {(value) => (
          <>
            <Notice tone="warn" icon="key">
              {t().apiKeyOneTime}
            </Notice>
            <Facts
              items={[
                { label: t().apiKey, value: value().token, copy: value().token, mono: true },
                ...(value().baseUrl
                  ? [
                      {
                        label: t().openAiBaseUrl,
                        value: value().baseUrl ?? "",
                        copy: value().baseUrl ?? "",
                        mono: true,
                        hint: t().openAiBaseUrlDescription,
                      },
                    ]
                  : []),
              ]}
            />
          </>
        )}
      </Show>
    </Dialog>
    </>
  );

  return { section, dialogs, create: () => openCreate() };
};
