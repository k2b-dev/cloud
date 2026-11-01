import { formatAppKey, generateAppKeyPair } from "@k2b/cloud/app-key";
import { coreClient } from "@k2b/cloud/clients/core";
import { downloadFileFromContent } from "@k2b/stdlib/browser";
import { mutation } from "@k2b/stdlib/solid";
import {
  Button,
  CodeDisplay,
  CopyButton,
  dialogCore,
  NoticeCard,
  PanelDialog,
  panelDialogOptions,
  SegmentedControl,
  TextInput,
} from "@k2b/ui";
import { createSignal, Match, onCleanup, Show, Switch } from "solid-js";
import { type KeysMessages, keysMessages } from "./keys-messages";

const api = coreClient.admin.apps;
type App = { id: string; name: string };
export type KeyEntry = {
  keyId: string;
  name: string;
  publicKey: string;
  fingerprint: string;
  status: "active" | "expired" | "revoked";
  /** The app's service account; "disabled" turns background access off for all its keys. */
  accountStatus?: "active" | "disabled";
  createdAt: string;
  createdBy: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
};

/** "3f9ac21e…" as four-character groups, as `cld` prints it. */
export const groupFingerprint = (fingerprint: string) => fingerprint.match(/.{1,4}/g)?.join(" ") ?? fingerprint;

const smallDialog = panelDialogOptions;

/** Whether this browser can create the pair itself; otherwise the column points to `cld`. */
export const keyCreationSupport = async (): Promise<"ok" | "insecure" | "no-ed25519"> => {
  if (!window.isSecureContext || !crypto?.subtle) return "insecure";
  try {
    await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]);
    return "ok";
  } catch (error) {
    // An engine without Ed25519 rejects the name; an OperationError refuses only this pair, and creating tries again (#2286).
    return error instanceof DOMException && error.name === "OperationError" ? "ok" : "no-ed25519";
  }
};

/** The artifact formats `cld admin apps keys create` writes, so a key saved here and one saved there read the same. */
const artifact = (appId: string, privateKey: string, format: "key" | "compose" | "k8s") => {
  if (format === "key") return `${privateKey}\n`;
  if (format === "compose") return `services:\n  ${appId}:\n    environment:\n      CLOUD_APP_KEY: ${JSON.stringify(privateKey)}\n`;
  return `apiVersion: v1\nkind: Secret\nmetadata:\n  name: ${appId.slice(0, 50)}-app-key\ntype: Opaque\nstringData:\n  CLOUD_APP_KEY: ${JSON.stringify(privateKey)}\n`;
};

/**
 * Creates a key in the browser and registers only its public part. A lost answer never creates a second key: the
 * same pair is registered again, which Core answers idempotently. The private key is shown once, afterwards.
 */
export const openCreateKeyDialog = (app: App, locale: string, onCreated: () => void) =>
  dialogCore.open<void>(
    (close, context) => {
      const t = keysMessages.resolve([locale]).t;
      const [name, setName] = createSignal(
        `${locale.startsWith("de") ? "produktion" : "production"}-${new Date().toISOString().slice(0, 7)}`,
      );
      const [problem, setProblem] = createSignal<"failed" | "unclear" | "limit" | null>(null);
      let pair: { seed: string; publicKey: string } | null = null;
      const register = mutation.create({
        mutation: async (_: void, { abortSignal }) => {
          pair ??= await generateAppKeyPair();
          const response = await api[":appId"].keys
            .$post(
              { param: { appId: app.id }, json: { publicKey: pair.publicKey, ...(name().trim() ? { name: name().trim() } : {}) } },
              { init: { signal: abortSignal } },
            )
            .catch(() => null);
          if (!response) throw Object.assign(new Error("unclear"), { kind: "unclear" as const });
          if (response.status === 409) throw Object.assign(new Error("limit"), { kind: "limit" as const });
          if (!response.ok) throw Object.assign(new Error("failed"), { kind: "failed" as const });
          const body = (await response.json()) as { keyId: string; installationId: string; fingerprint: string };
          return {
            ...body,
            privateKey: formatAppKey({ installationId: body.installationId, appId: app.id, keyId: body.keyId, seed: pair.seed }),
          };
        },
        onError: (error) => setProblem((error as { kind?: "failed" | "unclear" | "limit" }).kind ?? "failed"),
        onSuccess: (created) => {
          close();
          onCreated();
          void openOnceDialog(app, name().trim() || "App key", created.privateKey, created.fingerprint, t);
        },
      });
      onCleanup(() => register.abort());
      context.setDismissHandler(() => {
        if (!register.loading()) close();
      });
      const submit = (event: SubmitEvent) => {
        event.preventDefault();
        if (!register.loading()) {
          setProblem(null);
          void register.mutate();
        }
      };
      return (
        <form class="contents" onSubmit={submit} data-key-create>
          <PanelDialog>
            <PanelDialog.Header
              title={t.create}
              subtitle={app.name}
              icon="ti ti-key"
              close={() => close()}
              closeDisabled={register.loading()}
            />
            <PanelDialog.Body>
              <div class="flex flex-col gap-3">
                <p>{t.createIntro}</p>
                <TextInput
                  label={
                    <>
                      {t.keyName} <span class="font-normal text-dimmed">{t.optional}</span>
                    </>
                  }
                  value={name}
                  onValueChange={setName}
                  maxLength={120}
                  disabled={register.loading() || problem() !== null}
                />
                <Switch>
                  <Match when={problem() === "failed"}>
                    <NoticeCard tone="danger" icon="ti ti-alert-circle" role="alert">
                      <span>
                        <b>{t.registerFailedLead}</b> {t.registerFailedText}
                      </span>
                    </NoticeCard>
                  </Match>
                  <Match when={problem() === "unclear"}>
                    <NoticeCard tone="warning" icon="ti ti-help-circle" role="alert">
                      <span>
                        <b>{t.unclearLead}</b> {t.unclearText}
                      </span>
                    </NoticeCard>
                  </Match>
                  <Match when={problem() === "limit"}>
                    <NoticeCard tone="warning" icon="ti ti-info-circle" role="alert">
                      {t.limitReached}
                    </NoticeCard>
                  </Match>
                </Switch>
              </div>
            </PanelDialog.Body>
            <PanelDialog.Footer>
              <Button variant="secondary" disabled={register.loading()} onClick={() => close()}>
                {t.cancel}
              </Button>
              <Show when={problem() !== "limit"}>
                <Button type="submit" loading={register.loading()}>
                  <i class={`ti ${problem() === "unclear" ? "ti-search" : problem() ? "ti-refresh" : "ti-key"}`} aria-hidden="true" />
                  {register.loading() ? t.registering : problem() === "unclear" ? t.check : problem() ? t.retry : t.createAction}
                </Button>
              </Show>
            </PanelDialog.Footer>
          </PanelDialog>
        </form>
      );
    },
    { ...smallDialog, ariaLabel: keysMessages.resolve([locale]).t.create, initialFocus: "first-input" },
  );

/** Shows the private key exactly once. Closing before copying or downloading asks first, because it cannot come back. */
const openOnceDialog = (app: App, keyName: string, privateKey: string, fingerprint: string, t: KeysMessages) =>
  dialogCore.open<void>(
    (close, context) => {
      const [format, setFormat] = createSignal<"key" | "compose" | "k8s">("key");
      const [saved, setSaved] = createSignal<"copied" | "downloaded" | null>(null);
      const fileName = () => (format() === "k8s" ? `${app.id}-app-key.secret.yaml` : `${app.id}.key`);
      const download = () => {
        downloadFileFromContent(artifact(app.id, privateKey, format() === "k8s" ? "k8s" : "key"), fileName());
        setSaved("downloaded");
      };
      const dismiss = async () => {
        if (saved()) return close();
        const leave = await dialogCore.open<boolean>(
          (answer) => (
            <PanelDialog>
              <div class="contents">
                <PanelDialog.Header title={t.unsavedTitle} icon="ti ti-alert-triangle" close={() => answer(false)} />
                <PanelDialog.Body>
                  <div class="flex flex-col gap-3">
                    <p>{t.unsavedText}</p>
                  </div>
                </PanelDialog.Body>
                <PanelDialog.Footer>
                  <Button variant="secondary" onClick={() => answer(true)}>
                    {t.closeAnyway}
                  </Button>
                  <Button onClick={() => answer(false)}>{t.backToKey}</Button>
                </PanelDialog.Footer>
              </div>
            </PanelDialog>
          ),
          { ...smallDialog, role: "alertdialog", ariaLabel: t.unsavedTitle },
        );
        if (leave) close();
      };
      context.setDismissHandler(dismiss);
      return (
        <PanelDialog>
          <div class="contents" data-key-once>
            <PanelDialog.Header title={t.saveTitle} subtitle={`${app.name} · ${keyName}`} icon="ti ti-key" close={() => void dismiss()} />
            <PanelDialog.Body>
              <div class="flex flex-col gap-3">
                <NoticeCard tone="warning" icon="ti ti-alert-triangle">
                  <span>
                    <b>{t.onlyNowLead}</b> {t.onlyNowText}
                  </span>
                </NoticeCard>
                <SegmentedControl
                  ariaLabel={t.format}
                  size="sm"
                  value={format}
                  onValueChange={setFormat}
                  options={[
                    { value: "key", label: t.formatKey },
                    { value: "compose", label: t.formatCompose },
                    { value: "k8s", label: t.formatK8s },
                  ]}
                />
                <CodeDisplay code={artifact(app.id, privateKey, format()).trimEnd()} copy={false} lineNumbers={false} language="text" />
                <div class="flex flex-wrap items-center gap-2">
                  <CopyButton
                    text={artifact(app.id, privateKey, format()).trimEnd()}
                    label={format() === "compose" ? t.copySnippet : t.copy}
                    copiedLabel={t.copied}
                    size="sm"
                    variant="secondary"
                    onCopied={() => setSaved((value) => value ?? "copied")}
                  />
                  <Button size="sm" variant="secondary" onClick={download}>
                    <i class="ti ti-download" aria-hidden="true" />
                    {t.download({ file: fileName() })}
                  </Button>
                  <span
                    class="inline-flex items-center gap-1 text-[13px] text-(--k2b-success-text)"
                    style={{ visibility: saved() === "downloaded" ? "visible" : "hidden" }}
                  >
                    <i class="ti ti-check" aria-hidden="true" />
                    {t.downloaded}
                  </span>
                </div>
                <p class="text-[13px] text-dimmed">
                  {t.fingerprint} <span class="font-mono text-secondary">{groupFingerprint(fingerprint)}</span>
                </p>
              </div>
            </PanelDialog.Body>
            <PanelDialog.Footer>
              <Button onClick={() => void dismiss()}>{t.done}</Button>
            </PanelDialog.Footer>
          </div>
        </PanelDialog>
      );
    },
    { ...smallDialog, ariaLabel: t.saveTitle, cancelBehavior: "ignore" },
  );

/** Revokes one key after asking; the last active key says what that means for the next start. */
export const openRevokeKeyDialog = (app: App, key: KeyEntry, last: boolean, locale: string, onRevoked: () => void) =>
  dialogCore.open<void>(
    (close, context) => {
      const t = keysMessages.resolve([locale]).t;
      const revoke = mutation.create({
        mutation: async (_: void, { abortSignal }) => {
          const response = await api[":appId"].keys[":keyId"]
            .$delete({ param: { appId: app.id, keyId: key.keyId } }, { init: { signal: abortSignal } })
            .catch(() => null);
          // A lost answer may hide a revocation that happened: read the list again and let a retry repeat it safely.
          if (!response) {
            onRevoked();
            throw Object.assign(new Error("unclear"), { unclear: true });
          }
          if (!response.ok) throw new Error("failed");
        },
        onSuccess: () => {
          close();
          onRevoked();
        },
      });
      onCleanup(() => revoke.abort());
      context.setDismissHandler(() => {
        if (!revoke.loading()) close();
      });
      return (
        <PanelDialog>
          <div class="contents" data-key-revoke>
            <PanelDialog.Header
              title={t.revokeTitle({ name: key.name })}
              subtitle={`${app.name} · ${groupFingerprint(key.fingerprint)}`}
              icon="ti ti-key-off"
              close={() => close()}
              closeDisabled={revoke.loading()}
            />
            <PanelDialog.Body>
              <div class="flex flex-col gap-3">
                <p>{t.revokeText({ app: app.name })}</p>
                <Show when={last}>
                  <NoticeCard tone="warning" icon="ti ti-alert-triangle">
                    <span>
                      <b>{t.lastKeyLead}</b> {t.lastKeyText({ app: app.name })}
                    </span>
                  </NoticeCard>
                </Show>
                <Show when={revoke.error()}>
                  {(error) => (
                    <NoticeCard tone={"unclear" in error() ? "warning" : "danger"} icon="ti ti-alert-circle" role="alert">
                      <span>
                        <b>{"unclear" in error() ? t.unclearLead : t.revokeFailedLead}</b>{" "}
                        {"unclear" in error() ? t.revokeUnclearText : t.revokeFailedText}
                      </span>
                    </NoticeCard>
                  )}
                </Show>
              </div>
            </PanelDialog.Body>
            <PanelDialog.Footer>
              <Button variant="secondary" disabled={revoke.loading()} onClick={() => close()}>
                {t.cancel}
              </Button>
              <Button variant="danger" loading={revoke.loading()} onClick={() => void revoke.mutate()}>
                {revoke.loading() ? t.revoking : revoke.error() ? t.retry : t.revokeAction}
              </Button>
            </PanelDialog.Footer>
          </div>
        </PanelDialog>
      );
    },
    { ...smallDialog, role: "alertdialog", ariaLabel: keysMessages.resolve([locale]).t.revokeTitle({ name: key.name }) },
  );

const workloads = coreClient.admin.identity.workloads;

/** The token way of today's App credentials page, for one app: create shows the token once, revoke asks first. */
export const openTokenDialog = (app: App, locale: string, onChanged: () => void, token?: { id: string; name: string; prefix: string }) =>
  dialogCore.open<void>(
    (close, context) => {
      const t = keysMessages.resolve([locale]).t;
      const [name, setName] = createSignal("");
      const [expiresAt, setExpiresAt] = createSignal("");
      const [created, setCreated] = createSignal<string | null>(null);
      const run = mutation.create({
        mutation: async (_: void, { abortSignal }) => {
          if (token) {
            const response = await workloads[":appId"].credentials[":credentialId"].$delete(
              { param: { appId: app.id, credentialId: token.id } },
              { init: { signal: abortSignal } },
            );
            if (!response.ok) throw new Error(t.tokenFailed);
            return null;
          }
          const response = await workloads[":appId"].credentials.$post(
            {
              param: { appId: app.id },
              json: { name: name().trim(), scopes: ["identity:invoke"], ...(expiresAt().trim() ? { expiresAt: expiresAt().trim() } : {}) },
            },
            { init: { signal: abortSignal } },
          );
          const result = (await response.json()) as { token?: string; message?: string };
          if (!response.ok || !result.token) throw new Error(result.message ?? t.tokenFailed);
          return result.token;
        },
        onSuccess: (value) => {
          onChanged();
          if (value) setCreated(value);
          else close();
        },
      });
      onCleanup(() => run.abort());
      context.setDismissHandler(() => {
        if (!run.loading() && !created()) close();
      });
      const submit = (event: SubmitEvent) => {
        event.preventDefault();
        if (!run.loading() && !created() && (token || name().trim())) void run.mutate();
      };
      return (
        <form class="contents" onSubmit={submit} data-token-dialog>
          <PanelDialog>
            <PanelDialog.Header
              title={created() ? t.tokenOnce : token ? t.revokeAction : t.tokenCreate}
              subtitle={app.name}
              icon="ti ti-key"
              close={created() ? undefined : () => close()}
              closeDisabled={run.loading()}
            />
            <PanelDialog.Body>
              <div class="flex flex-col gap-3">
                <Show
                  when={created()}
                  fallback={
                    <Show
                      when={token}
                      fallback={
                        <>
                          <TextInput
                            label={t.tokenName}
                            value={name}
                            onValueChange={setName}
                            required
                            maxLength={120}
                            disabled={run.loading()}
                          />
                          <TextInput
                            label={t.tokenExpiry}
                            value={expiresAt}
                            onValueChange={setExpiresAt}
                            placeholder="2027-01-01T00:00:00Z"
                            disabled={run.loading()}
                          />
                        </>
                      }
                    >
                      {(shown) => (
                        <>
                          <p class="font-medium">{shown().name}</p>
                          <p class="font-mono text-xs text-dimmed">{shown().prefix}</p>
                          <NoticeCard tone="warning" icon="ti ti-alert-triangle">
                            {t.tokenRevokeConfirm}
                          </NoticeCard>
                        </>
                      )}
                    </Show>
                  }
                >
                  {(value) => <TextInput multiline label="CLOUD_APP_CREDENTIAL" value={value()} readOnly monospace />}
                </Show>
                <Show when={run.error()}>
                  {(error) => (
                    <NoticeCard tone="danger" icon="ti ti-alert-circle" role="alert">
                      {error().message}
                    </NoticeCard>
                  )}
                </Show>
              </div>
            </PanelDialog.Body>
            <PanelDialog.Footer>
              <Show
                when={created()}
                fallback={
                  <>
                    <Button variant="secondary" disabled={run.loading()} onClick={() => close()}>
                      {t.cancel}
                    </Button>
                    <Button
                      type="submit"
                      variant={token ? "danger" : "primary"}
                      loading={run.loading()}
                      disabled={!token && !name().trim()}
                    >
                      {token ? t.revokeAction : t.tokenCreate}
                    </Button>
                  </>
                }
              >
                <Button onClick={() => close()}>{t.tokenSaved}</Button>
              </Show>
            </PanelDialog.Footer>
          </PanelDialog>
        </form>
      );
    },
    { ...smallDialog, ariaLabel: keysMessages.resolve([locale]).t.tokenCreate, initialFocus: "first-input" },
  );
