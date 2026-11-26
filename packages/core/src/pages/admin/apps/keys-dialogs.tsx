import { formatAppKey, generateAppKeyPair } from "@k2b/cloud/app-key";
import { coreClient } from "@k2b/cloud/clients/core";
import { copyToClipboard, downloadFileFromContent } from "@k2b/stdlib/browser";
import { CodeDisplay } from "@k2b/ui";
import { Button, Choice, Dialog, Facts, Field, Input, Notice, Text, useToast } from "@k2b/ui/v2";
import { createSignal, Match, Show, Switch } from "solid-js";
import type { KeysMessages } from "./keys-messages";

const api = coreClient.admin.apps;
const workloads = coreClient.admin.identity.workloads;
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

/** Whether this browser can create the pair itself; otherwise the keys view points to `cld`. */
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

type Format = "key" | "compose" | "k8s";

/** The artifact formats `cld admin apps keys create` writes, so a key saved here and one saved there read the same. */
const artifact = (appId: string, privateKey: string, format: Format) => {
  if (format === "key") return `${privateKey}\n`;
  if (format === "compose") return `services:\n  ${appId}:\n    environment:\n      CLOUD_APP_KEY: ${JSON.stringify(privateKey)}\n`;
  return `apiVersion: v1\nkind: Secret\nmetadata:\n  name: ${appId.slice(0, 50)}-app-key\ntype: Opaque\nstringData:\n  CLOUD_APP_KEY: ${JSON.stringify(privateKey)}\n`;
};

export type CreatedKey = { name: string; privateKey: string; fingerprint: string };

/**
 * Creates a key in the browser and registers only its public part. A lost answer never creates a second key: the
 * same pair is registered again, which Core answers idempotently. `onCreated` hands the private key on, once.
 */
export const CreateKeyDialog = (props: {
  app: App;
  t: KeysMessages;
  locale: string;
  open: boolean;
  onClose: () => void;
  onCreated: (created: CreatedKey) => void;
}) => {
  const t = () => props.t;
  const [name, setName] = createSignal(
    `${props.locale.startsWith("de") ? "produktion" : "production"}-${new Date().toISOString().slice(0, 7)}`,
  );
  const [problem, setProblem] = createSignal<"failed" | "unclear" | "limit" | null>(null);
  const [busy, setBusy] = createSignal(false);
  let pair: { seed: string; publicKey: string } | null = null;
  const register = async () => {
    if (busy()) return;
    setBusy(true);
    setProblem(null);
    try {
      pair ??= await generateAppKeyPair();
      const response = await api[":appId"].keys
        .$post({ param: { appId: props.app.id }, json: { publicKey: pair.publicKey, ...(name().trim() ? { name: name().trim() } : {}) } })
        .catch(() => null);
      if (!response) return setProblem("unclear");
      if (response.status === 409) return setProblem("limit");
      if (!response.ok) return setProblem("failed");
      const body = (await response.json()) as { keyId: string; installationId: string; fingerprint: string };
      const privateKey = formatAppKey({ installationId: body.installationId, appId: props.app.id, keyId: body.keyId, seed: pair.seed });
      pair = null;
      props.onCreated({ name: name().trim() || "App key", privateKey, fingerprint: body.fingerprint });
    } catch {
      setProblem("failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t().create}
      open={props.open}
      dismissible={!busy()}
      onOpenChange={(open) => {
        if (!open && !busy()) props.onClose();
      }}
      foot={
        <>
          <Button disabled={busy()} onClick={props.onClose}>
            {t().cancel}
          </Button>
          <Show when={problem() !== "limit"}>
            <Button
              variant="primary"
              icon={problem() === "unclear" ? "search" : problem() ? "refresh" : "key"}
              busy={busy()}
              onClick={() => void register()}
            >
              {problem() === "unclear" ? t().check : problem() ? t().retry : t().createAction}
            </Button>
          </Show>
        </>
      }
    >
      <Text>{t().createIntro}</Text>
      <Field name="key-name" label={t().keyName}>
        <Input value={name()} disabled={busy() || problem() !== null} onInput={setName} />
      </Field>
      <Switch>
        <Match when={problem() === "failed"}>
          <Notice tone="bad" title={t().registerFailedLead}>
            {t().registerFailedText}
          </Notice>
        </Match>
        <Match when={problem() === "unclear"}>
          <Notice tone="warn" title={t().unclearLead}>
            {t().unclearText}
          </Notice>
        </Match>
        <Match when={problem() === "limit"}>
          <Notice tone="warn">{t().limitReached}</Notice>
        </Match>
      </Switch>
    </Dialog>
  );
};

/** Shows the private key exactly once. Closing before copying or downloading asks first, because it cannot come back. */
export const OnceDialog = (props: { app: App; t: KeysMessages; created: CreatedKey | null; onClose: () => void }) => {
  const t = () => props.t;
  const toast = useToast();
  const [format, setFormat] = createSignal<Format>("key");
  const [saved, setSaved] = createSignal(false);
  const text = () => (props.created ? artifact(props.app.id, props.created.privateKey, format()) : "");
  const fileName = () => (format() === "k8s" ? `${props.app.id}-app-key.secret.yaml` : `${props.app.id}.key`);
  const copy = async () => {
    try {
      await copyToClipboard(text().trimEnd());
      setSaved(true);
      toast(t().copied, { status: "ok" });
    } catch {
      toast(t().copyFailed, { status: "bad" });
    }
  };
  const download = () => {
    if (!props.created) return;
    downloadFileFromContent(artifact(props.app.id, props.created.privateKey, format() === "k8s" ? "k8s" : "key"), fileName());
    setSaved(true);
    toast(t().downloaded, { status: "ok" });
  };
  const leave = async () => {
    if (
      saved() ||
      (await Dialog.confirm({ title: t().unsavedTitle, description: t().unsavedText, confirm: t().closeAnyway, cancel: t().backToKey }))
    ) {
      setSaved(false);
      setFormat("key");
      props.onClose();
    }
  };
  return (
    <Dialog
      title={t().saveTitle}
      open={props.created !== null}
      onOpenChange={(open) => {
        if (!open) void leave();
      }}
      foot={<Button onClick={() => void leave()}>{t().done}</Button>}
    >
      <Notice tone="warn" title={t().onlyNowLead}>
        {t().onlyNowText}
      </Notice>
      <Choice
        name="key-format"
        label={t().format}
        value={format()}
        onChange={(value) => setFormat(value as Format)}
        options={[
          { value: "key", label: t().formatKey },
          { value: "compose", label: t().formatCompose },
          { value: "k8s", label: t().formatK8s },
        ]}
      />
      {/* k2b-ui gap: v2 has no code view; the v1 display stands in for the key and its snippets. */}
      <CodeDisplay code={text().trimEnd()} copy={false} lineNumbers={false} language="text" />
      <Facts items={[{ label: t().fingerprint, value: groupFingerprint(props.created?.fingerprint ?? ""), mono: true }]} />
      <Button icon="copy" onClick={() => void copy()}>
        {format() === "compose" ? t().copySnippet : t().copy}
      </Button>
      <Button icon="download" onClick={download}>
        {t().download({ file: fileName() })}
      </Button>
    </Dialog>
  );
};

/** Creates a token of today's host operation and shows it once; closing waits until the person says it is saved. */
export const TokenDialog = (props: { app: App; t: KeysMessages; open: boolean; onClose: () => void; onChanged: () => void }) => {
  const t = () => props.t;
  const [name, setName] = createSignal("");
  const [expiresAt, setExpiresAt] = createSignal("");
  const [created, setCreated] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const close = () => {
    setName("");
    setExpiresAt("");
    setCreated(null);
    setError(null);
    props.onClose();
  };
  const create = async () => {
    if (busy() || !name().trim()) return;
    setBusy(true);
    setError(null);
    try {
      const response = await workloads[":appId"].credentials.$post({
        param: { appId: props.app.id },
        json: { name: name().trim(), scopes: ["identity:invoke"], ...(expiresAt().trim() ? { expiresAt: expiresAt().trim() } : {}) },
      });
      const result = (await response.json().catch(() => ({}))) as { token?: string; message?: string };
      if (!response.ok || !result.token) return setError(result.message ?? t().tokenFailed);
      setCreated(result.token);
      props.onChanged();
    } catch {
      setError(t().tokenFailed);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={created() ? t().tokenOnce : t().tokenCreate}
      open={props.open}
      dismissible={!busy() && !created()}
      onOpenChange={(open) => {
        if (!open && !busy() && !created()) close();
      }}
      foot={
        <Show
          when={created()}
          fallback={
            <>
              <Button disabled={busy()} onClick={close}>
                {t().cancel}
              </Button>
              <Button variant="primary" busy={busy()} disabled={!name().trim()} onClick={() => void create()}>
                {t().tokenCreate}
              </Button>
            </>
          }
        >
          <Button variant="primary" onClick={close}>
            {t().tokenSaved}
          </Button>
        </Show>
      }
    >
      <Show
        when={created()}
        fallback={
          <>
            <Field name="token-name" label={t().tokenName} required>
              <Input value={name()} disabled={busy()} onInput={setName} />
            </Field>
            <Field name="token-expiry" label={t().tokenExpiry}>
              <Input value={expiresAt()} placeholder="2027-01-01T00:00:00Z" disabled={busy()} onInput={setExpiresAt} />
            </Field>
          </>
        }
      >
        {(token) => <Facts items={[{ label: "CLOUD_APP_CREDENTIAL", value: token(), copy: token(), mono: true }]} />}
      </Show>
      <Show when={error()}>
        {(message) => (
          <Notice tone="bad" title={t().tokenFailed}>
            {message()}
          </Notice>
        )}
      </Show>
    </Dialog>
  );
};
